import type { Env } from './index';

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

interface ChatRequest {
    message: string;
    conversationId?: string;
    context?: string;
}

async function getWebsiteContext(env: Env, query: string): Promise<string> {
    const listResult = await env.HTML_FISH88.list({ prefix: '', limit: 100 });
    
    const htmlFiles = listResult.objects
        .filter(obj => obj.key.endsWith('.html'))
        .slice(0, 10);
    
    let context = 'Nội dung website:\n\n';
    
    for (const file of htmlFiles) {
        const object = await env.HTML_FISH88.get(file.key);
        if (object) {
            const content = await object.text();
            const cleanText = content
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            
            context += `[${file.key}]: ${cleanText.substring(0, 500)}\n\n`;
        }
    }
    
    return context;
}

async function runAIModel(env: Env, messages: ChatMessage[]): Promise<string> {
    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: messages,
        max_tokens: 2048,
        temperature: 0.7,
        top_p: 0.9,
    });
    
    if (response && typeof response === 'object' && 'response' in response) {
        return response.response as string;
    }
    
    return 'Xin lỗi, tôi không thể trả lời câu hỏi này lúc này.';
}

function createSystemPrompt(websiteContext: string): string {
    return `Bạn là trợ lý AI thông minh của website mhcomputer.org. Nhiệm vụ của bạn là:

1. Trả lời các câu hỏi về nội dung website dựa trên context được cung cấp
2. Giải thích chi tiết, rõ ràng về sản phẩm, dịch vụ máy tính
3. Hỗ trợ khách hàng tìm hiểu về cấu hình máy tính, linh kiện
4. Tư vấn chọn máy tính phù hợp với nhu cầu
5. Trả lời bằng tiếng Việt, giọng điệu thân thiện và chuyên nghiệp

Context từ website:
${websiteContext}

Hãy sử dụng thông tin từ context để trả lời chính xác. Nếu không tìm thấy thông tin, hãy thông báo rõ ràng và đề xuất liên hệ trực tiếp.`;
}

async function storeConversation(env: Env, conversationId: string, messages: ChatMessage[]): Promise<void> {
    const key = `conversations:${conversationId}`;
    await env.CHAT_KV.put(key, JSON.stringify(messages), {
        expirationTtl: 86400
    });
}

async function loadConversation(env: Env, conversationId: string): Promise<ChatMessage[]> {
    const key = `conversations:${conversationId}`;
    const data = await env.CHAT_KV.get(key);
    
    if (!data) {
        return [];
    }
    
    return JSON.parse(data) as ChatMessage[];
}

export async function handleAIChat(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const body = await request.json() as ChatRequest;
        const { message, conversationId, context } = body;

        if (!message || message.trim() === '') {
            return new Response(JSON.stringify({ error: 'Message is required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const cid = conversationId || `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        let conversationHistory: ChatMessage[] = [];
        if (conversationId) {
            conversationHistory = await loadConversation(env, conversationId);
        }

        const websiteContext = context || await getWebsiteContext(env, message);
        
        if (conversationHistory.length === 0) {
            conversationHistory.push({
                role: 'system',
                content: createSystemPrompt(websiteContext)
            });
        }

        conversationHistory.push({
            role: 'user',
            content: message
        });

        const aiResponse = await runAIModel(env, conversationHistory);

        conversationHistory.push({
            role: 'assistant',
            content: aiResponse
        });

        await storeConversation(env, cid, conversationHistory);

        return new Response(JSON.stringify({
            success: true,
            conversationId: cid,
            response: aiResponse,
            timestamp: new Date().toISOString()
        }), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache'
            }
        });

    } catch (error) {
        console.error('AI Chat Error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            message: error instanceof Error ? error.message : 'Unknown error'
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

export async function handleAIHealthCheck(env: Env): Promise<Response> {
    try {
        const testResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [{ role: 'user', content: 'test' }],
            max_tokens: 10
        });

        return new Response(JSON.stringify({
            status: 'healthy',
            model: '@cf/meta/llama-3.1-8b-instruct',
            timestamp: new Date().toISOString()
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({
            status: 'unhealthy',
            error: error instanceof Error ? error.message : 'Unknown error'
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}