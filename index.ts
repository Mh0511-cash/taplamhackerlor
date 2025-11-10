import { handleStaticFile } from './htmlHandler';
import { handleAIChat, handleAIHealthCheck, handleGetAnalytics } from './aiHandler';

export interface Env {
    HTML_FISH88: R2Bucket;
    AI: any;
    CHAT_KV: KVNamespace;
}

async function handleApiRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const endpoint = url.pathname.replace('/api/', '');
    
    const headers = new Headers({
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });

    let formData = new FormData();
    if (request.method === 'POST') {
        try {
            formData = await request.formData();
        } catch (error) {
            const body = await request.json().catch(() => ({})) as Record<string, string>;
            formData = new FormData();
            Object.entries(body).forEach(([key, value]) => {
                formData.append(key, value);
            });
        }
    }

    const action = formData.get('url')?.toString() || endpoint;

    return new Response(JSON.stringify({
        success: false,
        message: 'Invalid endpoint'
    }), { headers, status: 404 });
}

function handleCorsPrelight(): Response {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        }
    });
}

function handleDomainRedirect(url: URL): Response | null {
    const hostname = url.hostname;
    
    if (hostname === 'www.mhcomputer.org') {
        return Response.redirect(`https://mhcomputer.org${url.pathname}${url.search}`, 301);
    }
    
    if (!hostname.endsWith('mhcomputer.org')) {
        return new Response('Domain not supported', { status: 404 });
    }
    
    return null;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        try {
            const url = new URL(request.url);
            
            const redirectResponse = handleDomainRedirect(url);
            if (redirectResponse) {
                return redirectResponse;
            }

            if (request.method === 'OPTIONS') {
                return handleCorsPrelight();
            }

            if (url.pathname.startsWith('/api/')) {
                if (url.pathname === '/api/ai/chat') {
                    return handleAIChat(request, env);
                }
                if (url.pathname === '/api/ai/health') {
                    return handleAIHealthCheck(env);
                }
                if (url.pathname === '/api/ai/analytics') {
                    return handleGetAnalytics(env, request);
                }
                return handleApiRequest(request);
            }

            return await handleStaticFile(request, env);
            
        } catch (err) {
            console.error('💥 Server Error:', err);
            return new Response('Internal Server Error', { status: 500 });
        }
    }
} satisfies ExportedHandler<Env>;