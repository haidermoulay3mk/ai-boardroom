import PDFDocument from 'pdfkit';
import { DISCLAIMER, optionLabel, speakerName } from './report-md.ts';
import { CRITERIA } from './scoring.ts';
import type { Session } from './types.ts';

type Doc = PDFKit.PDFDocument;

const INK = '#17181c';
const MUTED = '#5d6470';
const FAINT = '#9aa0ab';
const LINE = '#e4e1da';
const PAPER = '#f6f2ea';
const BRASS = '#9a6b22';
const GO = '#2f7d5b';

const WIN_ANSI_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);

/** The built-in PDF fonts only cover Windows-1252, so drop anything outside it (emoji, CJK, Arabic). */
export function pdfText(input: string): string {
  const normalized = input
    .replace(/[→➡]/g, '->')
    .replace(/←/g, '<-')
    .replace(/−/g, '-')
    .replace(/[   ]/g, ' ');
  let out = '';
  for (const ch of normalized) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 10 || (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WIN_ANSI_EXTRA.has(ch)) out += ch;
  }
  return out;
}

export function renderPdf(s: Session): Promise<Buffer> {
  const doc: Doc = new PDFDocument({
    size: 'A4',
    margins: { top: 56, bottom: 64, left: 54, right: 54 },
    bufferPages: true,
    info: { Title: pdfText(s.title), Author: 'Boardroom', Subject: 'Board decision report', Creator: 'Boardroom' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  new Layout(doc, s).render();
  doc.end();
  return finished;
}

class Layout {
  private readonly doc: Doc;
  private readonly s: Session;
  private readonly left: number;
  private readonly width: number;

  constructor(doc: Doc, s: Session) {
    this.doc = doc;
    this.s = s;
    this.left = doc.page.margins.left;
    this.width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  }

  render(): void {
    this.header();
    if (this.s.verdict) this.verdict();
    else this.notice('The board has not reached a verdict in this session yet.');
    this.appendix();
    this.footers();
  }

  // ------------------------------------------------------------ helpers

  private ensure(height: number): void {
    const doc = this.doc;
    if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
  }

  private heading(text: string): void {
    this.ensure(48);
    this.doc.moveDown(0.9);
    this.doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BRASS).text(pdfText(text.toUpperCase()), this.left, this.doc.y, {
      width: this.width,
      characterSpacing: 1.2,
    });
    this.doc.moveDown(0.4);
  }

  private paragraph(text: string, size = 10.5, color = INK): void {
    this.doc.font('Helvetica').fontSize(size).fillColor(color).text(pdfText(text), this.left, this.doc.y, { width: this.width, lineGap: 2.5 });
  }

  private list(items: string[], numbered = false): void {
    items.forEach((item, i) => {
      this.ensure(18);
      const y = this.doc.y;
      this.doc.font('Helvetica-Bold').fontSize(10).fillColor(numbered ? BRASS : FAINT).text(numbered ? `${i + 1}.` : '•', this.left, y, { width: 18 });
      this.doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(pdfText(item), this.left + 18, y, { width: this.width - 18, lineGap: 2 });
      this.doc.moveDown(0.3);
    });
  }

  private notice(text: string): void {
    this.doc.moveDown(1);
    this.paragraph(text, 11, MUTED);
  }

  private color(id: string): string {
    if (id === 'founder') return BRASS;
    if (id === 'chair') return INK;
    return this.s.cast.find(a => a.id === id)?.color ?? MUTED;
  }

  // ------------------------------------------------------------ sections

  private header(): void {
    const { doc, s, left, width } = this;
    const date = new Date(s.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(BRASS).text('BOARDROOM  ·  DECISION REPORT', left, 34, { width, characterSpacing: 1.4 });
    doc.font('Helvetica').fontSize(8).fillColor(FAINT).text(pdfText(date), left, 34, { width, align: 'right' });
    doc.font('Times-Bold').fontSize(23).fillColor(INK).text(pdfText(s.title), left, 64, { width, lineGap: 1 });
    doc.moveDown(0.35);
    this.paragraph(s.input.decision, 10.5, MUTED);
  }

  private verdict(): void {
    const { doc, s, left, width } = this;
    const v = s.verdict;
    if (!v) return;

    // Verdict card
    doc.moveDown(1);
    const top = doc.y;
    const textWidth = width - 150;
    doc.font('Times-Bold').fontSize(25);
    const labelHeight = doc.heightOfString(pdfText(v.label), { width: textWidth });
    doc.font('Helvetica').fontSize(11);
    const headlineHeight = v.headline ? doc.heightOfString(pdfText(v.headline), { width: textWidth, lineGap: 2 }) : 0;
    const height = Math.max(labelHeight + headlineHeight + 46, 104);
    this.ensure(height + 10);
    const y = doc.y === top ? top : doc.y;
    doc.rect(left, y, width, height).fill(PAPER);
    doc.rect(left, y, 5, height).fill(GO);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(GO).text('THE BOARD RECOMMENDS', left + 22, y + 18, { width: textWidth, characterSpacing: 1.2 });
    doc.font('Times-Bold').fontSize(25).fillColor(INK).text(pdfText(v.label), left + 22, y + 32, { width: textWidth });
    if (v.headline) doc.font('Helvetica').fontSize(11).fillColor(MUTED).text(pdfText(v.headline), left + 22, doc.y + 4, { width: textWidth, lineGap: 2 });
    const scoreX = left + width - 120;
    doc.font('Helvetica-Bold').fontSize(38).fillColor(INK).text(String(v.score), scoreX, y + 22, { width: 100, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor(FAINT).text('out of 100', scoreX, y + 64, { width: 100, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(`${v.confidence.toUpperCase()} CONFIDENCE`, scoreX, y + 78, { width: 100, align: 'center', characterSpacing: 0.8 });
    doc.y = y + height;

    // Vote tally
    const options = s.intake?.options ?? [];
    const tallyText = options.map(o => `${o.label}: ${v.tally[o.id] ?? 0}`).join('     ');
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('BOARD VOTE   ', left, doc.y, { continued: true, characterSpacing: 1 });
    doc.font('Helvetica').fontSize(10).fillColor(INK).text(pdfText(tallyText), { characterSpacing: 0 });

    this.scorecard();

    this.heading("The chair's verdict");
    this.paragraph(v.speech);

    const by = (id: string) => (id ? ` (${speakerName(s, id)})` : '');
    if (v.strongestFor.length) {
      this.heading('Strongest case for');
      this.list(v.strongestFor.map(x => `${x.text}${by(x.by)}`));
    }
    if (v.strongestAgainst.length) {
      this.heading('Strongest case against');
      this.list(v.strongestAgainst.map(x => `${x.text}${by(x.by)}`));
    }
    if (v.conditions.length) {
      this.heading('Conditions');
      this.list(v.conditions);
    }
    if (v.risks.length) {
      this.heading('Key risks');
      this.list(v.risks.map(r => (r.mitigation ? `${r.risk} -> ${r.mitigation}` : r.risk)));
    }
    if (v.nextSteps.length) {
      this.heading('Next 14 days');
      this.list(v.nextSteps, true);
    }
    if (v.wouldChange.length) {
      this.heading('What would change the verdict');
      this.list(v.wouldChange);
    }
    if (v.dissent) {
      this.heading('Dissent');
      this.paragraph(v.dissent);
    }

    if (s.ballots.length) {
      this.heading('The ballots');
      for (const id of s.input.advisors) {
        const b = s.ballots.find(x => x.advisorId === id);
        if (!b) continue;
        this.ensure(34);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(this.color(id)).text(pdfText(speakerName(s, id)), left, doc.y, { continued: true });
        doc.font('Helvetica').fillColor(MUTED).text(pdfText(`   ${optionLabel(s, b.vote)} · conviction ${b.conviction}/10`));
        doc.font('Helvetica').fontSize(10).fillColor(INK).text(pdfText(b.reason), left, doc.y + 1, { width: this.width, lineGap: 2 });
        doc.moveDown(0.5);
      }
    }
  }

  private scorecard(): void {
    const { doc, s, left, width } = this;
    const v = s.verdict;
    const options = s.intake?.options ?? [];
    if (!v || !options.length) return;
    this.heading('Scorecard');
    const labelWidth = 150;
    const colWidth = (width - labelWidth) / options.length;
    const rowHeight = 21;
    this.ensure(rowHeight * (CRITERIA.length + 2) + 10);

    let y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(FAINT).text('CRITERION', left, y + 6, { width: labelWidth, characterSpacing: 0.8 });
    options.forEach((o, i) => {
      const x = left + labelWidth + i * colWidth;
      const winner = o.id === v.recommendation;
      if (winner) doc.roundedRect(x + 2, y, colWidth - 4, rowHeight * (CRITERIA.length + 2) + 4, 5).fill(PAPER);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(winner ? GO : MUTED).text(pdfText(o.label), x + 8, y + 6, {
        width: colWidth - 16,
        height: 12,
        ellipsis: true,
      });
    });
    y += rowHeight;

    for (const c of CRITERIA) {
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(c.label, left, y + 6, { width: labelWidth - 30, continued: false });
      doc.font('Helvetica').fontSize(8).fillColor(FAINT).text(`${c.weight}%`, left + labelWidth - 34, y + 7, { width: 28, align: 'right' });
      options.forEach((o, i) => {
        const score = v.scores.find(x => x.optionId === o.id)?.criteria.find(x => x.id === c.id)?.score ?? 0;
        const x = left + labelWidth + i * colWidth + 8;
        const barWidth = colWidth - 40;
        doc.roundedRect(x, y + 8, barWidth, 5, 2.5).fill(LINE);
        doc.roundedRect(x, y + 8, Math.max(3, (barWidth * score) / 10), 5, 2.5).fill(o.id === v.recommendation ? GO : FAINT);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(String(score), x + barWidth + 4, y + 5, { width: 20, align: 'right' });
      });
      y += rowHeight;
    }
    doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.8).strokeColor(INK).stroke();
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text('Weighted total', left, y + 6, { width: labelWidth });
    options.forEach((o, i) => {
      const total = v.scores.find(x => x.optionId === o.id)?.total ?? 0;
      const x = left + labelWidth + i * colWidth;
      doc.font('Helvetica-Bold').fontSize(11).fillColor(o.id === v.recommendation ? GO : INK).text(`${total}`, x + 8, y + 5, { width: colWidth - 16 });
    });
    doc.y = y + rowHeight + 4;
  }

  private appendix(): void {
    const { doc, s, left, width } = this;
    doc.addPage();
    doc.font('Times-Bold').fontSize(18).fillColor(INK).text('The meeting', left, doc.page.margins.top, { width });
    doc.moveDown(0.2);
    this.paragraph(`${s.cast.length - 1} advisors · ${s.input.model} · ${s.stats.calls} model calls`, 9.5, FAINT);

    if (s.input.context) {
      this.heading("Founder's context");
      this.paragraph(s.input.context);
    }
    if (s.intake?.questions.length) {
      this.heading("The chair's questions");
      for (const q of s.intake.questions) {
        this.ensure(30);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(pdfText(q.text), left, doc.y, { width });
        doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(pdfText(s.intake.answers?.[q.id] || '(skipped)'), left, doc.y + 1, { width, lineGap: 2 });
        doc.moveDown(0.5);
      }
    }

    this.heading('Transcript');
    for (const t of s.turns) {
      if (t.kind === 'intake' || t.kind === 'ballot') continue;
      this.ensure(36);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(this.color(t.speaker)).text(pdfText(speakerName(s, t.speaker).toUpperCase()), left, doc.y, {
        width,
        characterSpacing: 0.8,
      });
      doc.font('Helvetica').fontSize(10).fillColor(INK).text(pdfText(t.text), left, doc.y + 2, { width, lineGap: 2.2 });
      doc.moveDown(0.7);
    }
  }

  private footers(): void {
    const { doc, left, width } = this;
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0; // writing inside the margin would otherwise add a page
      const y = doc.page.height - 44;
      doc.font('Helvetica').fontSize(7).fillColor(FAINT).text(pdfText(DISCLAIMER), left, y, { width: width - 60, lineGap: 1 });
      doc.text(`${i - range.start + 1} / ${range.count}`, left + width - 50, y, { width: 50, align: 'right' });
      doc.page.margins.bottom = bottom;
    }
  }
}
