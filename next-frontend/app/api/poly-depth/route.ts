import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const revalidate = 5;

export async function GET(req: NextRequest) {
  const notifierUrl = process.env.NOTIFIER_URL?.trim();
  if (!notifierUrl) return NextResponse.json({ error: 'NOTIFIER_URL not configured' }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const slug = searchParams.get('slug');
  const intent = searchParams.get('intent');
  const bfaImplied = searchParams.get('bfaImplied');
  const feeMode = searchParams.get('feeMode');
  const lambda = searchParams.get('lambda');
  if (!slug || !intent) return NextResponse.json({ error: 'missing slug or intent' }, { status: 400 });

  const qs = new URLSearchParams({ slug, intent });
  if (bfaImplied) qs.set('bfaImplied', bfaImplied);
  if (feeMode) qs.set('feeMode', feeMode);
  if (lambda) qs.set('lambda', lambda);

  let resp: Response;
  try {
    resp = await fetch(`${notifierUrl.replace(/\/$/, '')}/depth?${qs.toString()}`, { method: 'GET' });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: 'notifier_unreachable', message }, { status: 502 });
  }

  const text = await resp.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return NextResponse.json(data, { status: resp.status });
}
