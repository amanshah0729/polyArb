import { execSync } from 'child_process';
import path from 'path';
import { NextResponse } from 'next/server';

export async function POST() {
  const projectRoot = path.resolve(process.cwd(), '..');
  try {
    execSync('node scripts/bfagaming/getBFAGamingArb.js', { cwd: projectRoot, timeout: 120000 });
    return NextResponse.json({ message: 'BFAGaming arb scan completed successfully' });
  } catch (error: any) {
    console.error('BFAGaming arb error:', error);
    return NextResponse.json({ error: `Failed to run BFAGaming scan: ${error.message}` }, { status: 500 });
  }
}
