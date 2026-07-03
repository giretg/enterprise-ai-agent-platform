import { NextResponse } from 'next/server'

export function apiOk<T>(data: T, status = 200) {
  return NextResponse.json({ success: true, data }, { status })
}

export function apiError(message: string, status: number, details?: unknown) {
  return NextResponse.json({ success: false, error: message, details }, { status })
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new Error('Invalid JSON body')
  }
}
