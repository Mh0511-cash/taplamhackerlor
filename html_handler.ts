import Env from "./index";

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.txt': 'text/plain',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav'
} as const;

function getMimeType(filename: string): string {
    const ext = '.' + filename.split('.').pop()?.toLowerCase();
    return MIME_TYPES[ext as keyof typeof MIME_TYPES] || 'application/octet-stream';
}

function normalizeKey(pathname: string): string {
    let decodedPathname = decodeURIComponent(pathname);
    let key = decodedPathname.slice(1) || 'index.html';
    
    if (key.startsWith('api/')) {
        return key;
    }
    
    if (key.includes('@')) {
        const parts = key.split('@');
        if (parts.length === 2) {
            const basePath = parts[0];
            const queryPart = parts[1];
            
            if (queryPart && !queryPart.startsWith('&')) {
                key = basePath + '@&' + queryPart;
            }
        }
        
        if (!key.endsWith('.html')) {
            key += '.html';
        }
    }
    else if (key.includes('&')) {
        if (!key.endsWith('.html')) {
            key += '.html';
        }
    }
    else if (!key.includes('.')) {
        key += '.html';
    }
    
    key = key.replace(/\/+/g, '/');
    
    return key;
}

function debugLog(request: Request, key: string, object: any | null): void {
    if (!object) {
        console.log(`🚨 404 - Path: ${new URL(request.url).pathname}, Key: ${key}`);
    } else if (Math.random() < 0.01) {
        console.log(`✅ ${request.method} ${new URL(request.url).pathname} -> ${key}`);
    }
}

function getCacheControl(key: string): string {
    if (key.match(/\.(js|css|jpg|jpeg|png|gif|ico|woff|woff2|ttf|eot|svg|webp)$/i)) {
        return 'public, max-age=31536000, immutable';
    } else if (key.endsWith('.html')) {
        return 'public, max-age=3600, must-revalidate';
    } else {
        return 'no-cache';
    }
}

async function serve404Page(env: Env): Promise<Response> {
    const notFoundPage = await env.HTML_FISH88.get('404.html');
    if (notFoundPage) {
        return new Response(notFoundPage.body, {
            status: 404,
            headers: { 
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache'
            }
        });
    }
    return new Response('Not Found', { status: 404 });
}

export async function handleStaticFile(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = normalizeKey(url.pathname);
    const object = await env.HTML_FISH88.get(key);
    
    debugLog(request, key, object);
    
    if (!object) {
        if (key.endsWith('.html')) {
            return await serve404Page(env);
        }
        return new Response('Not Found', { status: 404 });
    }

    const headers = new Headers();
    const contentType = getMimeType(key);
    const cacheControl = getCacheControl(key);
    
    headers.set('Content-Type', contentType);
    headers.set('Cache-Control', cacheControl);
    headers.set('Access-Control-Allow-Origin', '*');
    
    if (object.httpMetadata?.contentLength) {
        headers.set('Content-Length', object.httpMetadata.contentLength.toString());
    }
    
    if (object.httpEtag) {
        headers.set('ETag', object.httpEtag);
    }

    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch && object.httpEtag && ifNoneMatch === object.httpEtag) {
        return new Response(null, {
            status: 304,
            headers: {
                'ETag': object.httpEtag,
                'Cache-Control': cacheControl
            }
        });
    }

    return new Response(object.body, { headers });
}