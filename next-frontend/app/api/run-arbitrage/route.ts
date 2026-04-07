import { execSync } from 'child_process';
import path from 'path';
import { NextResponse } from 'next/server';

export const maxDuration = 300;

export async function POST() {
  const projectRoot = path.resolve(process.cwd(), '..');
  try {
    execSync('node findAllArbitrage.js', {
      cwd: projectRoot,
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return NextResponse.json({ message: 'Arbitrage run successfully' });
  } catch (error: any) {
    console.error('Error details:', error);
    return NextResponse.json({ error: `Failed to run arbitrage: ${error.message}` }, { status: 500 });
  }
}