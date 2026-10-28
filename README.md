# UMLith

A Next.js editor for visual application design. Architecture, ER models and activities have separate canvases within one project.

```bash
npm install
npm run dev
```

Open [localhost:3000](http://localhost:3000).

- **SL / EN** switches the language of the interface, checks and new AI requests. The choice is saved in the browser. Names and descriptions in existing models stay unchanged. Translations are in `app/lib/messages.ts`.
- **Dark mode / Light mode**, next to the language selector, changes the appearance of the entire editor. The choice is saved in the browser. The first visit follows your system preference.
- **New** opens an empty project. Use **Undo** to restore your previous work.
- Click an element in the library, move it, and drag between handles to create a connection.
- Click an element or connection to edit properties, attributes, methods, stereotypes, packages and cardinalities.
- **Comment** adds a frame with a section title and description on any of the three canvases. Drag its title to move it, or resize it using the edges or the Width and Height fields. The frame sits behind elements and does not move them with it. Its position and size are saved in JSON. Its text is also included in PlantUML comments and the AI prompt.
- **PlantUML** shows a live export of the current diagram. Copy the code or download a `.puml` file.
- **AI architecture** sends your prompt and current project to Codex CLI, Claude Code CLI, a local LLM or a connected MCP client. **Generate architecture** returns a proposal. **Review model** checks for errors, missing rules and open questions.
- Review the proposal and click **Apply proposal**. You can then edit it on all three canvases. **Undo** restores the previous project. If you change the model while waiting, applying the outdated proposal is disabled.
- Manual text and `.md` exports are available under **Copy prompt manually** in the AI window.
- Your work is saved automatically in the browser's local storage. **Save JSON** creates a portable copy of all diagrams and positions. **Open** imports such a copy.

The project stays in your browser until you send an AI request. That request sends the entire current model and your instructions to the selected provider. MCP requests and responses are also stored locally in `.umlith/ai/` (excluded from Git). Clearing browser data removes the local copy, so export important models as JSON.

## Connecting to AI

**Codex / Claude Code:** The CLI must be installed, available in `PATH` and signed in (`codex login` or `claude auth login`). You can leave the model field empty. The app uses a separate temporary directory, with Codex in read-only mode and Claude without tools. It does not modify source files. You can cancel a request. The timeout is three minutes. The CLI uses your provider login and its usage limits or billing. To use an existing session, select MCP.

**Local LLM:** Select this provider and enter the exact name of the loaded model. The default endpoint is Ollama at `http://127.0.0.1:11434/v1/chat/completions`. For LM Studio, add this to `.env.local` and restart the app:

```dotenv
UMLITH_LOCAL_URL=http://127.0.0.1:1234/v1/chat/completions
```

The app uses an OpenAI-compatible `chat/completions` endpoint with JSON responses. The server must run on the same computer and support this format. The app runs on `127.0.0.1`. The AI API rejects remote requests and requests from other web origins.

**MCP:** Add the bridge to your client once (Node.js 22.13+). Commands for this checkout:

```bash
codex mcp add umlith -- node --experimental-strip-types /home/senad/CodeGenerator/scripts/umlith-mcp.mjs
claude mcp add umlith -- node --experimental-strip-types /home/senad/CodeGenerator/scripts/umlith-mcp.mjs
```

For a different checkout, replace the path. The JSON configuration is also available under **Connect via MCP** in the AI window. If the server is not visible yet, reopen the client session. The bridge uses stdio and finds `.umlith/ai/` relative to the project, so the app and client do not need the same working directory. To use a different data location, set the same absolute `UMLITH_AI_DIR` for both.

In the app, select **MCP**, write your instructions and submit the request. Copy the displayed instruction, including its ID, into your connected Codex, Claude Code or other MCP client. MCP does not wake an AI session on its own: the client must start reading. The tools are `umlith_list_requests`, `umlith_get_request` and `umlith_submit_result`. The app automatically displays the returned response. The request and response remain available after refreshing the same tab. **Cancel MCP request** removes the request. It does not start or stop the AI session itself.

MCP accepts `{ "summary": "...", "project": { ... } }` for generation and `{ "summary": "..." }` for a review. The exact schema, source model and instructions are available in `umlith_get_request`. Invalid projects are rejected. Reviews also work with incomplete activity diagrams.

The CLI integrations follow the [official OpenAI documentation for non-interactive Codex](https://developers.openai.com/codex/noninteractive/) and the [Claude Code CLI documentation](https://code.claude.com/docs/en/cli-reference). The bridge follows the [MCP stdio protocol](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

## Initial scope

Architecture supports components, classes, interfaces, entities, enums and notes. ER models support attributes and relationship cardinalities. Activities support a start, actions, decisions with two branches, parallel forks, joins and ends. Activity export uses PlantUML legacy syntax, which supports connections through aliases and loops.

**Check** validates basic structure and activity reachability. It does not simulate business logic, validate ER schema correctness or formally prove that parallel branches join correctly. Incomplete activities must be fixed before export. Edit the text in the center of an activity under **Properties → Text**. Activity text and descriptions are included as comments in the PlantUML export.

Arbitrary PlantUML import, multi-user collaboration and all UML diagram types are not supported yet. Imports and AI requests are limited to 5 MB. Projects are limited to 500 elements and 2000 connections per diagram. The selected diagram is stored in the URL. Project data stays in the same browser.

The starter project is a small Process Order example based on the supplied references. Changes in one diagram intentionally do not modify the other diagrams.

## Verification

With Node.js 22.13 or newer:

```bash
npm test
npm run lint
npm run build
```

The tests cover JSON round trips, validation, connections and cardinalities, branch and synchronization exports, loops, and export structure safeguards. The canvas uses [React Flow](https://reactflow.dev/learn). Export syntax follows [PlantUML class diagrams](https://plantuml.com/class-diagram) and [activity diagrams](https://plantuml.com/activity-diagram-legacy).
