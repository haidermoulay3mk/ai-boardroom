// Stands in for `claude -p --input-format stream-json --output-format stream-json ...` in tests.
// Prompt keywords: HANG (never answer), FAIL_AUTH (auth error result), ECHO_ARGS (reply with argv).
const args = process.argv.slice(2);
const out = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (args.includes('--version')) {
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
}
if (args[0] === 'auth') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', email: 'someone@example.com' }));
  process.exit(0);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line).message.content);
  }
});
process.stdin.on('end', () => process.exit(0));

function handle(prompt) {
  out({ type: 'system', subtype: 'init', model: 'fake' });
  if (prompt.includes('HANG')) return;
  if (prompt.includes('FAIL_AUTH')) {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' });
    return;
  }
  const text = prompt.includes('ECHO_ARGS') ? JSON.stringify(args) : 'Hello from the fake CLI. <meta>{"leaning":"A","conviction":7}</meta>';
  out({ type: 'stream_event', event: { type: 'message_start' } });
  for (let i = 0; i < text.length; i += 7) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(i, i + 7) } } });
  }
  out({ type: 'stream_event', event: { type: 'message_stop' } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text });
}
