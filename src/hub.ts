import type { ServerResponse } from 'node:http';

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Server-Sent Events fan-out, one channel per session. */
export class Hub {
  private readonly clients = new Map<string, Set<ServerResponse>>();
  private readonly timer: NodeJS.Timeout;

  constructor() {
    this.timer = setInterval(() => this.ping(), 20_000);
    this.timer.unref();
  }

  add(id: string, res: ServerResponse): void {
    let set = this.clients.get(id);
    if (!set) {
      set = new Set();
      this.clients.set(id, set);
    }
    const channel = set;
    channel.add(res);
    res.on('close', () => {
      channel.delete(res);
      if (!channel.size) this.clients.delete(id);
    });
  }

  send(id: string, event: string, data: unknown): void {
    const set = this.clients.get(id);
    if (!set?.size) return;
    const payload = frame(event, data);
    for (const res of set) res.write(payload);
  }

  sendTo(res: ServerResponse, event: string, data: unknown): void {
    res.write(frame(event, data));
  }

  close(): void {
    clearInterval(this.timer);
    for (const set of this.clients.values()) for (const res of set) res.end();
    this.clients.clear();
  }

  private ping(): void {
    for (const set of this.clients.values()) for (const res of set) res.write(': ping\n\n');
  }
}
