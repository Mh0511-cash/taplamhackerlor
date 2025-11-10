import type { Env } from './index';

// Giới hạn FREE tier
const FREE_TIER_LIMITS = {
    dailyRequests: 100,        // 100 requests mỗi ngày mỗi IP
    maxTokensPerRequest: 1000, // Giảm từ 2048 xuống 1000 để tiết kiệm
    conversationTimeout: 3600,  // 1 giờ thay vì 24 giờ
    maxConversationLength: 10   // Tối đa 10 tin nhắn mỗi hội thoại
};

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

interface ChatRequest {
    message: string;
    conversationId?: string;
    context?: string;
}

interface UserInfo {
    ip: string;
    country?: string;
    city?: string;
    region?: string;
    timezone?: string;
    latitude?: string;
    longitude?: string;
    asn?: string;
    userAgent: string;
    referer?: string;
    language?: string;
    device: string;
    browser: string;
    os: string;
    timestamp: string;
}

interface ChatAnalytics {
    userId: string;
    userInfo: UserInfo;
    conversationId: string;
    message: string;
    response: string;
    tokenCount: number;
    responseTime: number;
    timestamp: string;
}

// Hàm phân tích User Agent để lấy thông tin device, browser, OS
function parseUserAgent(userAgent: string): { device: string; browser: string; os: string } {
    let device = 'Desktop';
    let browser = 'Unknown';
    let os = 'Unknown';

    // Detect Device
    if (/mobile/i.test(userAgent)) device = 'Mobile';
    else if (/tablet|ipad/i.test(userAgent)) device = 'Tablet';

    // Detect Browser
    if (/edg/i.test(userAgent)) browser = 'Edge';
    else if (/chrome/i.test(userAgent)) browser = 'Chrome';
    else if (/firefox/i.test(userAgent)) browser = 'Firefox';
    else if (/safari/i.test(userAgent)) browser = 'Safari';
    else if (/opera|opr/i.test(userAgent)) browser = 'Opera';

    // Detect OS
    if (/windows/i.test(userAgent)) os = 'Windows';
    else if (/macintosh|mac os x/i.test(userAgent)) os = 'macOS';
    else if (/linux/i.test(userAgent)) os = 'Linux';
    else if (/android/i.test(userAgent)) os = 'Android';
    else if (/iphone|ipad|ipod/i.test(userAgent)) os = 'iOS';

    return { device, browser, os };
}

// Thu thập đầy đủ thông tin người dùng
function collectUserInfo(request: Request): UserInfo {
    const userAgent = request.headers.get('user-agent') || 'Unknown';
    const { device, browser, os } = parseUserAgent(userAgent);

    // Cloudflare tự động thêm các headers này
    const userInfo: UserInfo = {
        ip: request.headers.get('cf-connecting-ip') || 'Unknown',
        country: request.headers.get('cf-ipcountry') || undefined,
        city: request.headers.get('cf-ipcity') || undefined,
        region: request.headers.get('cf-region') || undefined,
        timezone: request.headers.get('cf-timezone') || undefined,
        latitude: request.headers.get('cf-iplat') || undefined,
        longitude: request.headers.get('cf-iplon') || undefined,
        asn: request.headers.get('cf-asn') || undefined,
        userAgent: userAgent,
        referer: request.headers.get('referer') || undefined,
        language: request.headers.get('accept-language')?.split(',')[0] || undefined,
        device: device,
        browser: browser,
        os: os,
        timestamp: new Date().toISOString()
    };

    return userInfo;
}

// Kiểm tra rate limit cho user (FREE tier)
async function checkRateLimit(env: Env, ip: string): Promise<{ allowed: boolean; remaining: number }> {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const key = `ratelimit:${ip}:${today}`;
    
    const current = await env.CHAT_KV.get(key);
    const count = current ? parseInt(current) : 0;

    if (count >= FREE_TIER_LIMITS.dailyRequests) {
        return { allowed: false, remaining: 0 };
    }

    await env.CHAT_KV.put(key, (count + 1).toString(), {
        expirationTtl: 86400 // 24 giờ
    });

    return { 
        allowed: true, 
        remaining: FREE_TIER_LIMITS.dailyRequests - count - 1 
    };
}

// Lưu analytics để dashboard có thể hiển thị
async function saveAnalytics(env: Env, analytics: ChatAnalytics): Promise<void> {
    const key = `analytics:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
    await env.CHAT_KV.put(key, JSON.stringify(analytics), {
        expirationTtl: 2592000 // Giữ 30 ngày
    });

    // Lưu tổng số request để dashboard đếm
    const statsKey = 'stats:total_requests';
    const current = await env.CHAT_KV.get(statsKey);
    const total = current ? parseInt(current) : 0;
    await env.CHAT_KV.put(statsKey, (total + 1).toString());
}

async function getWebsiteContext(env: Env, query: string): Promise<string> {
    // Cache context để tiết kiệm tài nguyên
    const cacheKey = 'cache:website_context';
    const cached = await env.CHAT_KV.get(cacheKey);
    
    if (cached) {
        return cached;
    }

    const listResult = await env.HTML_FISH88.list({ prefix: '', limit: 50 });
    const htmlFiles = listResult.objects
        .filter(obj => obj.key.endsWith('.html'))
        .slice(0, 5); // Giảm xuống 5 file để tiết kiệm tokens
    
    let context = 'Nội dung website MH Computer:\n\n';
    
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
            
            context += `[${file.key}]: ${cleanText.substring(0, 300)}\n\n`;
        }
    }
    
    // Cache trong 1 giờ
    await env.CHAT_KV.put(cacheKey, context, { expirationTtl: 3600 });
    
    return context;
}

async function runAIModel(env: Env, messages: ChatMessage[]): Promise<string> {
    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: messages,
        max_tokens: FREE_TIER_LIMITS.maxTokensPerRequest,
        temperature: 0.7,
        top_p: 0.9,
    });
    
    if (response && typeof response === 'object' && 'response' in response) {
        return response.response as string;
    }
    
    return 'Xin lỗi, tôi không thể trả lời câu hỏi này lúc này.';
}

function createSystemPrompt(websiteContext: string): string {
    return `Bạn là trợ lý AI của MH Computer tại mhcomputer.org. 

Nhiệm vụ của bạn:
- Tư vấn về máy tính, laptop, linh kiện PC
- Giải thích chi tiết về sản phẩm và dịch vụ
- Hỗ trợ chọn cấu hình phù hợp với nhu cầu
- Trả lời bằng tiếng Việt, ngắn gọn, rõ ràng
- Không được vượt quá 200 từ mỗi câu trả lời

Nội dung website:
${websiteContext}

Nếu không tìm thấy thông tin, đề xuất liên hệ hotline hoặc fanpage.`;
}

async function storeConversation(env: Env, conversationId: string, messages: ChatMessage[]): Promise<void> {
    // Giới hạn số lượng tin nhắn trong FREE tier
    const limitedMessages = messages.slice(-FREE_TIER_LIMITS.maxConversationLength);
    
    const key = `conversations:${conversationId}`;
    await env.CHAT_KV.put(key, JSON.stringify(limitedMessages), {
        expirationTtl: FREE_TIER_LIMITS.conversationTimeout
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

    const startTime = Date.now();
    const userInfo = collectUserInfo(request);

    try {
        // Kiểm tra rate limit
        const rateCheck = await checkRateLimit(env, userInfo.ip);
        if (!rateCheck.allowed) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Rate limit exceeded',
                message: 'Bạn đã vượt quá giới hạn 100 câu hỏi mỗi ngày. Vui lòng thử lại vào ngày mai.',
                remaining: 0
            }), {
                status: 429,
                headers: { 
                    'Content-Type': 'application/json',
                    'X-RateLimit-Remaining': '0',
                    'X-RateLimit-Reset': new Date(Date.now() + 86400000).toISOString()
                }
            });
        }

        const body = await request.json() as ChatRequest;
        const { message, conversationId, context } = body;

        if (!message || message.trim() === '') {
            return new Response(JSON.stringify({ error: 'Message is required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Giới hạn độ dài tin nhắn
        if (message.length > 500) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Message too long',
                message: 'Câu hỏi của bạn quá dài. Vui lòng giới hạn trong 500 ký tự.'
            }), {
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
        const responseTime = Date.now() - startTime;

        conversationHistory.push({
            role: 'assistant',
            content: aiResponse
        });

        await storeConversation(env, cid, conversationHistory);

        // Lưu analytics
        const analytics: ChatAnalytics = {
            userId: userInfo.ip,
            userInfo: userInfo,
            conversationId: cid,
            message: message,
            response: aiResponse,
            tokenCount: Math.ceil((message.length + aiResponse.length) / 4),
            responseTime: responseTime,
            timestamp: new Date().toISOString()
        };
        await saveAnalytics(env, analytics);

        return new Response(JSON.stringify({
            success: true,
            conversationId: cid,
            response: aiResponse,
            remaining: rateCheck.remaining,
            timestamp: new Date().toISOString()
        }), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'X-RateLimit-Remaining': rateCheck.remaining.toString()
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
            freeTierLimits: FREE_TIER_LIMITS,
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

// API để dashboard lấy analytics
export async function handleGetAnalytics(env: Env, request: Request): Promise<Response> {
    try {
        const url = new URL(request.url);
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const offset = parseInt(url.searchParams.get('offset') || '0');

        const listResult = await env.CHAT_KV.list({ prefix: 'analytics:', limit: limit + offset });
        const analytics: ChatAnalytics[] = [];

        for (const key of listResult.keys.slice(offset, offset + limit)) {
            const data = await env.CHAT_KV.get(key.name);
            if (data) {
                analytics.push(JSON.parse(data));
            }
        }

        const statsKey = 'stats:total_requests';
        const totalRequests = await env.CHAT_KV.get(statsKey);

        return new Response(JSON.stringify({
            success: true,
            analytics: analytics,
            total: parseInt(totalRequests || '0'),
            limit: limit,
            offset: offset
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}