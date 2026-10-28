# UMLith

Next.js urejevalnik za vizualno načrtovanje aplikacij. Arhitektura, ER model in aktivnosti imajo svoja platna v enem projektu.

```bash
npm install
npm run dev
```

Odpri [localhost:3000](http://localhost:3000).

- **SL / EN** preklopi jezik vmesnika, preverjanja in novih zahtev AI. Izbira se shrani v brskalniku. Imena in opisi v obstoječih modelih ostanejo nespremenjeni. Prevodi so v `app/lib/messages.ts`.
- **Temni način / Svetli način** ob izbiri jezika preklopi videz celotnega urejevalnika. Izbira se shrani v brskalniku, prvi obisk pa sledi sistemskemu videzu.
- **Nov** odpre prazen projekt. Prejšnje delo lahko povrneš z **Razveljavi**.
- Klikni element v knjižnici, ga premakni in povleci med priključkoma za povezavo.
- Klikni element ali povezavo za lastnosti, atribute, metode, stereotipe, pakete in kardinalnosti.
- **Komentar** na vseh treh platnih doda okvir z naslovom in opisom sklopa. Premikaš ga za naslov, velikost pa spreminjaš z robovi ali poljema Širina in Višina. Okvir je za elementi in jih ne premika skupaj s sabo. Položaj in velikost se shranita v JSON, besedilo pa tudi v PlantUML komentarje in prompt za AI.
- **PlantUML** pokaže sproten izvoz trenutnega diagrama. Kopiraj kodo ali prenesi `.puml`.
- **Arhitektura z AI** pošlje prompt in trenutni projekt v Codex CLI, Claude Code CLI, lokalni LLM ali povezani odjemalec MCP. **Izdelaj arhitekturo** vrne predlog, **Pridobi mnenje** pa pregled napak, manjkajočih pravil in odprtih vprašanj.
- Predlog preglej in klikni **Uporabi predlog**. Nato ga urejaš na vseh treh platnih. **Razveljavi** povrne prejšnji projekt. Če med čakanjem model spremeniš, je uporaba starega predloga onemogočena.
- Ročni izvoz besedila in `.md` ostaja pod **Ročno kopiranje prompta** v oknu AI.
- Delo se samodejno shranjuje v lokalni pomnilnik brskalnika. **Shrani JSON** naredi prenosljivo kopijo vseh diagramov in položajev. **Odpri** uvozi takšno kopijo.

Projekt ostane v brskalniku, dokler ne pošlješ zahteve AI. Ta pošlje celoten trenutni model in navodilo izbranemu ponudniku. Zahteve MCP in odgovori se hranijo tudi lokalno v `.umlith/ai/` (izključeno iz Git). Brisanje podatkov brskalnika odstrani lokalno kopijo, zato pomembne modele izvozi v JSON.

## Povezava z AI

**Codex / Claude Code:** CLI mora biti nameščen, v `PATH` in prijavljen (`codex login` oziroma `claude auth login`). Model lahko pustiš prazen. Aplikacija uporablja ločen začasni imenik, Codex v načinu samo za branje, Claude brez orodij. Ne spreminja izvornih datotek. Zahtevo lahko prekličeš, omejitev čakanja je tri minute. CLI uporablja prijavo ponudnika in njegove omejitve oziroma obračunavanje. Za uporabo obstoječe seje izberi MCP.

**Lokalni LLM:** izberi to povezavo in vpiši točno ime naloženega modela. Privzeti naslov je Ollama `http://127.0.0.1:11434/v1/chat/completions`. Za LM Studio nastavi v `.env.local` in ponovno zaženi aplikacijo:

```dotenv
UMLITH_LOCAL_URL=http://127.0.0.1:1234/v1/chat/completions
```

Uporabljen je OpenAI združljiv `chat/completions` z JSON odgovorom. Strežnik mora teči na istem računalniku in podpirati ta format. Aplikacija teče na `127.0.0.1`, AI API zavrača oddaljene in tuje spletne izvore.

**MCP:** v odjemalcu enkrat dodaj most (Node.js 22.13+). Ukaza za ta imenik:

```bash
codex mcp add umlith -- node --experimental-strip-types /home/senad/CodeGenerator/scripts/umlith-mcp.mjs
claude mcp add umlith -- node --experimental-strip-types /home/senad/CodeGenerator/scripts/umlith-mcp.mjs
```

Ob drugem imeniku zamenjaj pot, pravilna konfiguracija JSON je tudi v oknu AI pod **Povezava prek MCP**. Če strežnik še ni viden, ponovno odpri sejo odjemalca. Most uporablja stdio in sam poišče `.umlith/ai/` ob projektu, zato aplikacija in odjemalec ne potrebujeta istega delovnega imenika. Za drugo lokacijo podatkov obema nastavi isti absolutni `UMLITH_AI_DIR`.

V aplikaciji izberi **MCP**, napiši navodilo in oddaj zahtevo. Prikazano navodilo z ID kopiraj v povezani Codex, Claude Code ali drug MCP odjemalec. MCP sam ne zbudi AI seje: odjemalec mora začeti branje. Orodja so `umlith_list_requests`, `umlith_get_request` in `umlith_submit_result`. Aplikacija samodejno prikaže vrnjen odgovor. Zahteva in odgovor ostaneta dosegljiva po osvežitvi istega zavihka. **Prekliči zahtevo MCP** odstrani zahtevo. Ne zažene ali prekine same AI seje.

MCP sprejema odgovor `{ "summary": "...", "project": { ... } }` za izdelavo, za mnenje pa `{ "summary": "..." }`. Natančna shema, izvorni model in navodila so v `umlith_get_request`. Neveljavni projekti se zavrnejo. Pregled deluje tudi pri nepopolnih aktivnostih.

CLI povezavi sledita [uradni dokumentaciji OpenAI za neinteraktivni Codex](https://developers.openai.com/codex/noninteractive/) in [dokumentaciji Claude Code CLI](https://code.claude.com/docs/en/cli-reference), most pa [MCP stdio protokolu](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

## Prvi obseg

Arhitektura podpira komponente, razrede, vmesnike, entitete, enum in opombe. ER podpira atribute in kardinalnosti povezav. Aktivnosti podpirajo začetek, korake, odločitve z dvema vejama, vzporedni razcep, združitev in konec. Izvoz aktivnosti uporablja PlantUML legacy syntax, ki podpira povezave prek aliasov in povratne zanke.

**Preveri** preverja osnovno strukturo in dosegljivost aktivnosti. To ni poslovna simulacija, preverjanje pravilnosti ER sheme ali formalni dokaz, da se vzporedne veje pravilno združijo. Nepopolne aktivnosti je treba popraviti pred izvozom. Sredinsko besedilo aktivnosti urejaš v Lastnostih pod **Besedilo / Text**. Besedilo in opisi aktivnosti so v PlantUML izvozu komentarji.

Za zdaj ni uvoza poljubne PlantUML kode, sodelovanja več uporabnikov ali vseh vrst UML diagramov. Uvoz in AI zahteve so omejeni na 5 MB, projekti na 500 elementov in 2000 povezav na diagram. Izbrani diagram je zapisan v URL, podatki ostanejo v istem brskalniku.

Začetni projekt je manjši primer Process Order, oblikovan po priloženih referencah. Spremembe v enem diagramu namenoma ne spreminjajo drugih diagramov.

## Preverjanje

Node.js 22.13 ali novejši:

```bash
npm test
npm run lint
npm run build
```

Testi preverijo povratni uvoz JSON, validacijo, povezave in kardinalnosti, izvoz vej in sinhronizacij, zanke ter zaščito strukture izvoza. Platno uporablja [React Flow](https://reactflow.dev/learn). Sintaksa izvoza sledi [PlantUML class diagrams](https://plantuml.com/class-diagram) in [activity diagrams](https://plantuml.com/activity-diagram-legacy).
