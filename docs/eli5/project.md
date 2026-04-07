# What is OpenGolem?

OpenGolem is a self-hosted personal AI assistant. You run it on your own computer or server. You send messages — through a command-line prompt, Telegram, or other chat apps — and an AI agent (the program that reads your message and generates a reply) responds.

## The problem it solves

Most AI assistant services require you to hand two things to a third party: your conversations and your API key. An API key is a secret password that lets software call an external service on your behalf — in this case, Anthropic's AI servers. When you use a hosted assistant, that key and those conversations live in someone else's infrastructure.

OpenGolem is for people who want the capability without that trade-off. You keep your conversations on your own machine. Your API key is used by your own server to make calls to Anthropic — it is never stored in the agent's environment, written to disk, or passed to code you didn't explicitly authorize to hold it.

## What makes it different

**The AI agent never holds your real API key.** When the agent needs to call Anthropic's servers, it uses a temporary, limited-use pass issued just for that task — like a parking stub that opens one specific gate on one specific day, not a copy of your master key. The real credential stays in a part of the system the agent cannot reach. When the task is done, the pass is revoked.

**Every outbound request goes through a security checkpoint.** Before any call leaves your machine, a component called the Call Inspector checks it: is the AI calling a service it's supposed to call? Is it making calls at a normal rate? Does the request look like someone tried to slip unauthorized instructions into the conversation? Every check result is written to an audit log — a permanent, append-only record, like the flight recorder on an aircraft. You can inspect it at any time.

**There is a separate oversight process called Cato.** Cato is a name, not an acronym — it's the component that makes allow-or-block decisions about what the agent is allowed to do. It cannot be addressed by users or instructed by the agent. It simply watches and either allows or blocks. When it blocks something, the agent explains the block to you in plain language — it never goes silent without explanation.

## Why you'd want it

OpenGolem is for people who use AI assistants in contexts where these questions matter:

- Where does my data go?
- Could the agent be tricked into doing something I didn't authorize?
- Do I have a record of what the agent actually did?

It is not the easiest way to start using an AI assistant. It requires running your own server, setting up an isolated environment for the agent to run in, and managing your own credentials. The trade-off is an assistant you can actually audit.
