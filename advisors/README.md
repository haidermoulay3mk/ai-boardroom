# Advisors

Every `.md` file in this folder (except this README and files starting with `_`) is one seat at the table. Boardroom loads them when it starts, so adding an advisor is one file and a restart.

## File format

```markdown
---
id: naval              # lowercase letters, digits, dashes. Unique.
name: Naval Ravikant
short: Naval           # what the others call them at the table
title: The Leverage Philosopher
initials: NR
color: "#3b7d8c"       # accent colour, #rrggbb
seat: 9                # speaking order in opening statements
lens: Leverage, specific knowledge, long-term games with long-term people
---
How you think: ...
What you ask: ...
Your instincts: ...
How you sound: ...
```

The body is the persona. It's sent to the model as instructions, so write it in the second person ("you believe…"). The four sections above are the pattern that works best:

- **How you think**: the core ideas and frameworks this person is publicly known for.
- **What you ask**: the questions they'd put to a founder.
- **Your instincts**: which way they tend to lean, and what would change their mind. This creates the disagreement that makes the debate useful.
- **How you sound**: voice and rhythm, so the eight of them don't blur together.

Exactly one file must have `role: chair` and `id: chair`. That's the moderator.

## Ground rules for contributed advisors

- Base personas on **publicly known ideas** (books, essays, talks, interviews), written in your own words. Don't paste passages from books.
- Don't add private details, invented anecdotes, or anything that implies the real person endorses Boardroom.
- Keep it useful: a persona earns its seat by bringing a lens the others don't have.
