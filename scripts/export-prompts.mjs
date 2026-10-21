import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = join(homedir(), '.claude', 'projects', root.replace(/[/.]/g, '-'));
const explicit = process.argv[2];
const transcript =
  explicit ??
  readdirSync(projectDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(projectDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

const strip = (text) =>
  text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .trim();

const textOf = (content) => {
  if (typeof content === 'string') return strip(content);
  return content
    .filter((block) => block.type === 'text')
    .map((block) => strip(block.text))
    .filter(Boolean)
    .join('\n\n');
};

const turns = [];
for (const line of readFileSync(transcript, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const entry = JSON.parse(line);
  if (entry.isSidechain || !entry.message) continue;
  if (entry.type === 'user') {
    const content = entry.message.content;
    const isToolResult = Array.isArray(content) && content.every((block) => block.type === 'tool_result');
    if (isToolResult) continue;
    const text = textOf(content);
    if (text) turns.push({ prompt: text, responses: [] });
  } else if (entry.type === 'assistant' && turns.length > 0) {
    const text = textOf(entry.message.content);
    if (text) turns.at(-1).responses.push(text);
  }
}

const out = [
  '# PROMPTS',
  '',
  'Every prompt and response of the build, in order, exported from the Claude Code session transcript by `scripts/export-prompts.mjs`.',
  'Tool calls and their raw output (file reads, shell commands, test runs) are not reproduced; the assistant text that explains them is. Prompts are in Spanish, as written.',
  '',
];
turns.forEach((turn, index) => {
  out.push(`## Turn ${index + 1}`, '', '### Prompt', '', turn.prompt, '', '### Response', '', turn.responses.join('\n\n') || '_(tool work only)_', '');
});
writeFileSync(join(root, 'PROMPTS.md'), out.join('\n'));
console.log(`wrote PROMPTS.md with ${turns.length} turns from ${transcript}`);
