import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const notifierUrl = process.env.NOTIFIER_URL?.trim();
  const token = process.env.EXECUTION_TOKEN;

  if (!notifierUrl) return NextResponse.json({ error: 'NOTIFIER_URL not configured' }, { status: 500 });
  if (!token) return NextResponse.json({ error: 'EXECUTION_TOKEN not configured on the web server' }, { status: 500 });

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  let resp: Response;
  try {
    resp = await fetch(`${notifierUrl.replace(/\/$/, '')}/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: 'notifier_unreachable', message }, { status: 502 });
  }

  const text = await resp.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return NextResponse.json(data, { status: resp.status });
}
