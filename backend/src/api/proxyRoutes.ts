/**
 * Proxy Routes
 * 
 * Handles URL preview (OpenGraph metadata) and image proxy functionality.
 * These routes fetch external content and return metadata or proxied images.
 */

import { getCORSHeaders } from '../config/cors.js';
import { fetchExternalUrlWithGuards } from '../utils/urlGuards.js';

interface UrlPreviewData {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  type: string | null;
  youtubeId: string | null;
  channelName: string | null;
  video: {
    url: string | null;
    type: string | null;
    width: string | null;
    height: string | null;
  } | null;
  twitterCard: string | null;
  twitterPlayer: string | null;
}

function decodeHtmlEntities(str: string): string {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function getMeta(html: string, property: string): string | null {
  // Try og: property first, then name attribute
  const ogMatch = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`, 'i'));
  return ogMatch ? decodeHtmlEntities(ogMatch[1]) : null;
}

export async function handleUrlPreview(req: any, res: any): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const targetUrl = url.searchParams.get('url');
  const corsHeaders = getCORSHeaders(req?.headers?.origin as string | undefined);
  
  if (!targetUrl) {
    res.writeHead(400, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({ error: 'Missing url parameter' }));
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetchExternalUrlWithGuards(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WabiBot/1.0; +https://wabi.chat)',
        'Accept': 'text/html'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      res.writeHead(502, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: 'Failed to fetch URL' }));
      return;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      res.writeHead(400, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: 'URL is not an HTML page' }));
      return;
    }

    const html = await response.text();

    let title = getMeta(html, 'og:title') || getMeta(html, 'twitter:title')
      || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]) || null;
    const description = getMeta(html, 'og:description') || getMeta(html, 'twitter:description')
      || getMeta(html, 'description') || null;
    const siteName = getMeta(html, 'og:site_name') || null;
    const type = getMeta(html, 'og:type') || null;

    // Video/player embed metadata
    const videoUrl = getMeta(html, 'og:video:secure_url') || getMeta(html, 'og:video:url') || getMeta(html, 'og:video') || null;
    const videoType = getMeta(html, 'og:video:type') || null;
    const videoWidth = getMeta(html, 'og:video:width') || getMeta(html, 'twitter:player:width') || null;
    let image = getMeta(html, 'og:image') || getMeta(html, 'twitter:image') || null;

    const videoHeight = getMeta(html, 'og:video:height') || getMeta(html, 'twitter:player:height') || null;
    const twitterCard = getMeta(html, 'twitter:card') || null;
    const twitterPlayer = getMeta(html, 'twitter:player') || null;

    // Extract YouTube video ID from URL
    let youtubeId: string | null = null;
    let channelName: string | null = null;
    try {
      const parsed = new URL(targetUrl);
      if (parsed.hostname.includes('youtube.com')) {
        youtubeId = parsed.searchParams.get('v') || null;
        if (!youtubeId) {
          const segments = parsed.pathname.split('/').filter(Boolean);
          if (segments.length >= 2 && (segments[0] === 'embed' || segments[0] === 'shorts')) {
            youtubeId = segments[1];
          }
        }
      } else if (parsed.hostname.includes('youtu.be')) {
        youtubeId = parsed.pathname.slice(1) || null;
      }
    } catch {}

    // For YouTube, use oEmbed API to get reliable title, channel name, and thumbnail
    if (youtubeId) {
      try {
        const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${youtubeId}&format=json`);
        if (oembedRes.ok) {
          const oembed = await oembedRes.json() as { title?: string; author_name?: string; thumbnail_url?: string };
          if (oembed.title) title = oembed.title;
          channelName = oembed.author_name || null;
          if (oembed.thumbnail_url && !image) image = oembed.thumbnail_url;
        }
      } catch (err) { console.error('[URL Preview] Failed to fetch YouTube oEmbed:', err); }
      
      // Guarantee a high-res thumbnail
      try {
        if (!image) {
          image = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
        } else {
          // Upgrade to maxresdefault if using ytimg
          image = `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;
        }
      } catch (err) { console.error('[URL Preview] Failed to generate fallback thumbnail URL:', err); }
    }

    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({
      title, description, image, siteName, type, youtubeId, channelName,
      video: videoUrl ? { url: videoUrl, type: videoType, width: videoWidth, height: videoHeight } : null,
      twitterCard, twitterPlayer
    }));
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({ error: 'Failed to fetch URL preview' }));
  }
}

export async function handleImageProxy(req: any, res: any): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const imageUrl = url.searchParams.get('url');
  const corsHeaders = getCORSHeaders(req?.headers?.origin as string | undefined);
  
  if (!imageUrl) {
    res.writeHead(400, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({ error: 'Missing url parameter' }));
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetchExternalUrlWithGuards(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WabiBot/1.0; +https://wabi.chat)',
        'Accept': 'image/*'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      res.writeHead(502, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: 'Failed to fetch image' }));
      return;
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
      ...corsHeaders
    });
    res.end(buffer);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({ error: 'Failed to proxy image' }));
  }
}
