// Pages Function for /chars/*: character pictures added without a deploy. The R2 bucket agent-dashboard-chars (binding
// CHARS, set on the Pages project) is read first — chars.json, the list of added characters, and their strips, put
// there by scripts/char-publish.py — and anything it does not hold falls through to the deployed files (the six
// built-in characters in frontend/chars). Revalidated on every load, answered with 304 while the ETag still matches.
export async function onRequestGet({ request, env, params }) {
  const key = 'chars/' + [].concat(params.path || []).join('/');
  const obj = env.CHARS && /^chars\/[a-z0-9-]+(\.json|\.webp|\.png)$/.test(key)
    ? await env.CHARS.get(key, { onlyIf: request.headers }) : null;
  if (!obj) return env.ASSETS.fetch(request);
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  h.set('cache-control', 'no-cache');
  h.set('x-content-type-options', 'nosniff');
  return 'body' in obj ? new Response(obj.body, { headers: h }) : new Response(null, { status: 304, headers: h });
}
export const onRequestHead = onRequestGet;
