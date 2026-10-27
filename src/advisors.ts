import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Advisor, AdvisorProfile } from './types.ts';

export interface Cast {
  chair: Advisor;
  /** Seated advisors, sorted by seat. */
  advisors: Advisor[];
  byId: Map<string, Advisor>;
}

/** Minimal frontmatter parser: `key: value` lines between --- fences. */
export function parseFrontmatter(src: string): { data: Record<string, string>; body: string } {
  const text = src.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text.trim() };
  const data: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return { data, body: (match[2] ?? '').trim() };
}

export function parseAdvisor(src: string, file: string): Advisor {
  const { data, body } = parseFrontmatter(src);
  const id = (data.id ?? '').trim();
  if (!/^[a-z0-9-]{2,40}$/.test(id)) throw new Error(`${file}: "id" must be 2-40 lowercase letters, digits or dashes.`);
  if (id === 'founder') throw new Error(`${file}: "founder" is reserved.`);
  const name = data.name?.trim();
  if (!name) throw new Error(`${file}: "name" is required.`);
  const role = data.role === 'chair' ? 'chair' : 'advisor';
  if (role === 'chair' && id !== 'chair') throw new Error(`${file}: the chair must use id "chair".`);
  const color = /^#[0-9a-fA-F]{6}$/.test(data.color ?? '') ? (data.color as string) : '#5b6472';
  return {
    id,
    role,
    name,
    short: data.short?.trim() || name.split(' ')[0] || name,
    title: data.title?.trim() ?? '',
    initials: (data.initials?.trim() || name.split(/\s+/).map(w => w[0]).join('')).slice(0, 3).toUpperCase(),
    color,
    seat: Number.parseInt(data.seat ?? '', 10) || 99,
    lens: data.lens?.trim() ?? '',
    persona: body,
  };
}

export function loadCast(dir: string): Cast {
  const files = readdirSync(dir).filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md' && !f.startsWith('_'));
  let chair: Advisor | null = null;
  const advisors: Advisor[] = [];
  const byId = new Map<string, Advisor>();
  for (const file of files) {
    const advisor = parseAdvisor(readFileSync(join(dir, file), 'utf8'), file);
    if (byId.has(advisor.id)) throw new Error(`${file}: duplicate advisor id "${advisor.id}".`);
    byId.set(advisor.id, advisor);
    if (advisor.role === 'chair') chair = advisor;
    else advisors.push(advisor);
  }
  if (!chair) throw new Error(`No chair found in ${dir}. Add a file with "role: chair".`);
  if (advisors.length < 2) throw new Error(`Need at least two advisors in ${dir}.`);
  advisors.sort((a, b) => a.seat - b.seat || a.name.localeCompare(b.name));
  return { chair, advisors, byId };
}

export function publicProfile(a: Advisor): AdvisorProfile {
  const { persona: _persona, ...profile } = a;
  return profile;
}
