import { execSync } from 'child_process';
import path from 'path';
import { NextResponse } from 'next/server';

export async function POST() {
  // Get the project root (one level up from next-frontend)
  const projectRoot = path.resolve(process.cwd(), '..');
  console.log('Target cwd:', projectRoot);
  try {
    execSync('node findAllArbitrage.js', { cwd: projectRoot });
    return NextResponse.json({ message: 'Arbitrage run successfully' });
  } catch (error: any) {
    console.error('Error details:', error);
    return NextResponse.json({ error: `Failed to run arbitrage: ${error.message}` }, { status: 500 });
  }
}