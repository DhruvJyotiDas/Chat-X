# IB Connect user-facing feature status

Audited against the repository and live deployment on 2026-09-10.

Current snapshot: **38 complete**, **28 partial**, **52 not implemented**, and **1 infrastructure claim unverified** across 119 requested capabilities.

Status meanings:

- **Complete** — the user flow is implemented end to end in the current application.
- **Partial** — a useful subset works, but one or more requirements in the requested feature are missing.
- **Not implemented** — no production user flow exists; a label, mock, or adjacent feature does not count.
- **Unverified** — infrastructure or policy evidence is required outside this repository.

## Account and privacy

| Requested capability | Status | Current implementation and remaining gap |
|---|---|---|
| Sign in using IB Account | **Complete** | OIDC authorization code flow with PKCE and nonce in `LoginPage.tsx`, `App.tsx`, and `server/main.go`; identity is provided by `ib-account`. |
| Stay securely signed in across sessions | **Complete** | IB Account maintains server sessions and IB Connect restores its signed session token. Token rotation/revocation could still be stronger. |
| Control what personal data and features IB Connect can access | **Partial** | Settings cover profile, presence status, notifications, devices, and personalization. There is no unified permissions/privacy center for AI, transcripts, files, calendar, or connectors. |
| Give or revoke consent for recording and analysis | **Not implemented** | Call recording is absent and there is no durable consent ledger for transcription or AI analysis. Captions are a local on/off action, not multi-party consent. |
| Choose individual AI features to enable or disable | **Not implemented** | AIPA features are manually triggered in several places, but there is no per-feature AI preference policy. |
| Delete your session data and related information | **Not implemented** | Users can delete individual AI memory/reminders and some local items. There is no complete account/session export-and-delete flow. |
| Keep private data separate from other participants | **Partial** | Thread membership and meeting transcript ACLs isolate normal access. Formal tenant isolation, connector ACLs, retention policy, and complete guest identity hardening remain. |
| Store data within India | **Unverified** | The current application VM is in the Mumbai environment, but the repository does not enforce or prove residency for database backups, AI/ASR providers, logs, or future object storage. |

## AIPA assistant

| Requested capability | Status | Current implementation and remaining gap |
|---|---|---|
| Use AIPA throughout IB Connect | **Partial** | A global Ask AIPA panel is available from the top bar, plus chat, dashboard, document, meeting, and interview AI surfaces. It is not yet a shared context layer across every product. |
| Help with conversations, calls, meetings, tasks, documents, and information | **Partial** | Conversation Q&A/analysis, meeting summaries, tasks/reminders, document extraction/Q&A, rewriting, translation, Daily Focus, and interviews work. General tool execution across these products does not. |
| Proactive assistance without asking first | **Partial** | Meeting mentions can create meeting cards; the dashboard surfaces Daily Focus, AI tasks, and reminders. There is no general ranked proactive suggestion engine, preference model, cooldown system, or feedback loop. |
| Suggestions based on the current conversation | **Complete** | Smart replies, conversation analysis, local conversation intelligence, task/reminder extraction, and meeting detection are implemented. |
| Find information from personal conversations and documents | **Partial** | Thread Q&A, keyword message search, and per-attachment document Q&A exist. There is no cross-conversation/document semantic retrieval or RAG index. |
| Search the external web when needed | **Not implemented** | AIPA has no web-search provider or browsing tool. |
| Cite web sources | **Not implemented** | No external web retrieval means there is no web citation pipeline. Daily Focus source references are internal IDs and are not equivalent to web citations. |

## Direct messaging

| Requested capability | Status | Current implementation and remaining gap |
|---|---|---|
| Private one-to-one chat | **Complete** | Direct threads are stored server-side and protected by thread membership. |
| Real-time send and receive | **Complete** | REST writes plus the authenticated `/chat-ws` fanout path update conversations live. |
| Delivered indicator | **Not implemented** | The server confirms message creation, but it does not store or display recipient delivery receipts. |
| Read indicator | **Partial** | Per-member `last_read_at` drives unread counts. The sender cannot see per-message read receipts or who read a message. |
| Scroll through older messages | **Partial** | Up to 500 messages are loaded. There is no cursor pagination or infinite history loading. |
| Securely store messages | **Partial** | Authentication, membership checks, TLS, and MariaDB persistence are present. Application-managed at-rest encryption and a documented key/retention policy are absent. |
| Surface relevant past information | **Partial** | Thread memory, Ask this conversation, analysis, and search help manually. Automatic contextual retrieval from long history is not implemented. |

## Groups and group messaging

| Requested capability | Status | Current implementation and remaining gap |
|---|---|---|
| Create and join group conversations | **Complete** | Named group creation and selected member insertion are implemented. |
| Send messages to the group | **Complete** | Group messages are persisted and broadcast only to thread members. |
| See who is present in a group | **Complete** | Group members and their current online/offline presence are shown. Presence is process/connection based rather than multi-region presence infrastructure. |
| See typing activity | **Complete** | Authenticated typing-start/stop events are scoped by thread membership. |
| See when messages have been read | **Not implemented** | Unread state exists per viewer, but group read receipts and read-by lists do not. |
| Keep activity scoped to group members | **Complete** | REST and WebSocket group actions validate membership. |
| Suggest when a group is inactive or unnecessary | **Not implemented** | No group lifecycle scoring or proactive archive suggestion exists. |
| Identify stale or duplicate groups | **Not implemented** | No duplicate membership/name detection or stale-group analysis exists. |

## Audio and video calls

| Requested capability | Status | Current implementation and remaining gap |
|---|---|---|
| Start one-to-one audio calls | **Complete** | Calls can be started as audio-only and invited through chat signaling. |
| Real-time audio | **Complete** | LiveKit carries participant audio, with TURN fallback for restrictive networks. |
| Mute/unmute microphone | **Complete** | Available before joining and during the call. |
| Start, pause, resume, or stop call recording | **Not implemented** | The interview recorder is separate; meeting recording and LiveKit Egress are not implemented. |
| Visible recording indicator | **Not implemented** | No call recording exists. |
| Connection quality indication | **Complete** | LiveKit connection quality is mapped to call badges, with RTT/relay detail in the participant panel. |
| Test microphone/device before joining | **Complete** | Pre-join preview opens camera and microphone and respects remembered device choices. |
| Start one-to-one video calls | **Complete** | The call flow supports camera publishing and direct invites. |
| Turn camera on/off | **Complete** | Available before and during calls. |
| Picture-in-picture/minimized call | **Complete** | Calls can minimize to a floating call window while users continue elsewhere in the app. |
| Spotlight and tiled views | **Complete** | Responsive paginated grid and participant pin/spotlight modes are implemented. |
| Adaptive video quality | **Complete** | LiveKit adaptive stream, dynacast, simulcast layers, visibility-aware subscriptions, and separate stage/grid limits are configured. |
| Check camera, microphone, and device before joining | **Complete** | Pre-join preview and in-call device switching are implemented. |
| Group audio and video calls | **Complete** | LiveKit SFU rooms support multiple audio/video participants. |
| Multi-participant tiled layout | **Complete** | Responsive layout, paging, active-speaker ordering, and large-room tile limits are implemented. |
| Group participant spotlight | **Complete** | Any visible participant can be pinned to the focus stage. |
| Continue calls with several participants in one room | **Complete** | SFU media, independent audio rendering, reconnection, and room membership support this. Multi-node SFU scaling is not yet configured. |

## Recording and consent

| Requested capability | Status | Current implementation and remaining gap |
|---|---|---|
| Consent before recording or analysis | **Not implemented** | No durable consent workflow. |
| Require all participants to agree | **Not implemented** | No consent state machine or server-side capture gate. |
| Start/pause/resume/stop recording | **Not implemented** | Meeting recording is absent. |
| Clearly show active recording | **Not implemented** | Meeting recording is absent. |
| Record when consent was granted or withdrawn | **Not implemented** | No consent event ledger. |
| Control individual AI analysis permissions | **Not implemented** | No room-level or participant-level AI analysis policy. |

## Conversation intelligence

| Requested capability | Status | Current implementation and remaining gap |
|---|---|---|
| Live speech-to-text captions | **Complete** | Browser audio is relayed to the configured ASR service and caption events return live. |
| Show who said what | **Complete** | Transcript lines bind speaker ID/name from meeting identity. |
| Follow a live transcript | **Complete** | The captions panel maintains a live speaker-labelled transcript. |
| Access transcript after the call | **Complete** | Transcript lines are persisted; the Meetings page now opens past meeting intelligence and downloads saved transcript text. |
| Search saved transcripts | **Not implemented** | Transcript persistence exists but there is no transcript search API or UI. |
| Summary with main topics/key points | **Complete** | Meeting summary returns overview and key points. |
| Summary with decisions | **Complete** | Structured decisions are extracted and displayed. |
| Summary with next steps and follow-up | **Complete** | Structured action items and owners are extracted and displayed. |
| Review summary before relying on it | **Complete** | The new active-call and post-call notes UI separates generated sections and explicitly asks users to review important output. Editing/versioning is not yet available. |

## Meetings and scheduling

| Requested capability | Status | Current implementation and remaining gap |
|---|---|---|
| Detect meeting discussions and scheduling phrases | **Complete** | A deterministic gate plus AI extraction detects, updates, and cancels proposed meetings in chat. |
| Automatically begin a scheduling flow | **Partial** | A meeting card/calendar event is produced automatically. There is no guided availability negotiation flow. |
| Connect a calendar | **Not implemented** | The existing calendar is browser-local and has no external OAuth connection. |
| Check everybody's availability | **Not implemented** | No Free/Busy connector or server calendar model. |
| Respect working hours | **Not implemented** | No working-hours preferences or scheduling constraint engine. |
| Handle time zones | **Partial** | AIPA receives the user's IANA timezone in some requests, but detected meeting scheduling currently uses server time and shared events do not preserve attendee time zones. |
| Suggest common meeting slots in the conversation | **Partial** | AIPA can extract/suggest a discussed date/time and create a meeting card. It does not compare participant availability. |
| Compare slots across participants | **Not implemented** | Requires connected calendars and private Free/Busy queries. |
| Pick a proposed slot | **Partial** | Users can accept detected cards into their local calendar or use the schedule modal. There is no multi-party slot-voting workflow. |
| One-tap meeting confirmation | **Partial** | Detected meeting cards provide one-action local calendar creation. Confirmation is not a durable participant acceptance workflow. |
| Add to all participant calendars | **Partial** | Each online/offline client syncs the shared card into its own browser-local calendar. No external or server calendar is updated. |
| Automatically include a meeting link | **Partial** | Manually scheduled meetings receive an IB Connect room code/link. AI-detected local calendar cards are not backed by a durable scheduled-room object. |
| Generate title | **Complete** | AI detection and manual scheduling produce a title. |
| Generate description and agenda | **Not implemented** | AI-detected cards use a fixed description and do not generate an editable agenda. |
| Edit generated meeting details before confirmation | **Not implemented** | Manual meetings can be entered by the user, but AI-generated cards do not have an edit-before-save review step. |
| Detect calendar conflicts and suggest alternatives | **Not implemented** | No server calendar/Free-Busy layer. |
| Keep private calendar details hidden | **Not implemented** | There is no multi-user calendar integration yet; future Free/Busy must expose availability without titles/details. |
| Show appointments created during a session | **Partial** | Detected meeting cards remain in chat and local calendar. There is no dedicated end-of-session appointment recap. |
| Google Calendar connection | **Not implemented** | No connector. |
| Outlook Calendar connection | **Not implemented** | No connector. |
| Apple Calendar connection | **Not implemented** | No connector or CalDAV/ICS sync. |

## AI action items and tasks

| Requested capability | Status | Current implementation and remaining gap |
|---|---|---|
| Automatically detect commitments/tasks | **Complete** | Conversation analysis and lightweight live intelligence detect statements such as “I’ll…” and persist AI tasks. |
| Assign tasks to the responsible participant | **Partial** | The model proposes an assignee and the server resolves it only against actual thread members. Ambiguous/no match remains unassigned. |
| Detect natural-language deadlines | **Partial** | Deadlines are extracted as text, but are not normalized into a durable date/time field. |
| Use the session time zone for deadlines | **Not implemented** | Task due phrases are stored as text; there is no timezone-aware deadline parser in the task system. |
| Infer task priority | **Not implemented** | `ai_tasks` has no priority field or urgency classifier. |
| Show live task previews | **Partial** | Lightweight intelligence appears while viewing conversation context and full tasks appear after analysis. There is no confidence-ranked live review queue. |
| Confirm before saving AI tasks | **Not implemented** | Thread analysis currently inserts detected tasks/reminders immediately. A review-and-confirm transaction is needed. |
| Prevent unwanted automatic task creation | **Not implemented** | Analysis is manually initiated, but once initiated its task results are saved without per-item confirmation. |
| Send tasks into the AIPA task system | **Complete** | Confirmed by the `ai_tasks` persistence/API and AI Inbox dashboard. |
| Keep tasks connected to broader workflow | **Partial** | Tasks retain thread and source-message IDs. There is no full Tasks product, project model, external sync, or source jump UI. |
| Share tasks with consenting participants | **Partial** | A task can resolve to a thread participant as owner. Consent and explicit acceptance are absent. |
| Notify assigned participants | **Not implemented** | No task-assignment notification event exists. |
| Detect and merge duplicate tasks | **Not implemented** | Re-running conversation analysis can create duplicate tasks. |
| Link task to the exact conversation moment | **Partial** | `source_message_id` is stored, but the UI does not expose a jump-to-source action. |

## Search and personal knowledge

| Requested capability | Status | Current implementation and remaining gap |
|---|---|---|
| Search messages and conversations | **Complete** | Authenticated keyword search spans the user's member threads and opens matching conversations. |
| Search call transcripts | **Not implemented** | Transcript search is absent. |
| Search documents | **Partial** | Individual attached documents can be extracted and questioned. There is no document library or cross-document search. |
| Search connected Drive files | **Not implemented** | No Drive connector. |
| Natural-language/meaning-based smart search | **Not implemented** | Current search is SQL keyword matching; there are no embeddings, vector search, reranking, or semantic index. |
| Combine messages, transcripts, and documents | **Not implemented** | Sources are handled by separate endpoints without unified retrieval. |
| Source citations and open-source navigation | **Not implemented** | Search results identify messages, and Daily Focus stores internal source refs, but generated answers do not cite exact source spans or provide universal open-source links. |

## Google Drive

| Requested capability | Status | Current implementation and remaining gap |
|---|---|---|
| Connect Google Drive | **Not implemented** | No OAuth connector or Drive API client. |
| Select which documents IB Connect can access | **Not implemented** | No Drive picker/scoped permission store. |
| Search Drive documents | **Not implemented** | No ingestion/indexing pipeline. |
| Retrieve shared document information | **Not implemented** | No Drive ACL-aware retrieval. |
| Ask AIPA about Drive documents | **Not implemented** | AIPA can ask about uploaded chat attachments only. |

## Proactive information surfacing

| Requested capability | Status | Current implementation and remaining gap |
|---|---|---|
| Notice relevant information from the past | **Partial** | Daily Focus, persisted decisions, reminders, and conversation intelligence surface some past context. Relevance is not computed against the user's current activity. |
| Surface an old message at the right moment | **Not implemented** | Search is user-triggered; there is no semantic proactive retrieval. |
| Surface a relevant document | **Not implemented** | No indexed document corpus or contextual suggestion engine. |
| Remind users about prior discussions | **Partial** | AI reminders and five-minute meeting reminders exist. General commitment follow-up timing is not normalized or scheduled. |
| Show floating contextual suggestions | **Partial** | Ask AIPA is globally available and AI meeting cards appear in chat, but no ranked floating suggestion system exists. |

## Web assistance

| Requested capability | Status | Current implementation and remaining gap |
|---|---|---|
| Answer questions requiring current external information | **Not implemented** | The model has no controlled web retrieval tool. |
| Search externally when private sources are insufficient | **Not implemented** | No source-routing policy or web search provider. |
| Ground answers in external sources | **Not implemented** | No retrieval or evidence validation layer. |
| Display citations for web answers | **Not implemented** | No citation model/UI. |
| Use external search only when needed | **Not implemented** | Requires an intent/router policy, privacy controls, allowlists, budgets, and citations before release. |

## Highest-value next implementation order

1. Add recording/transcription/AI consent policy, a durable consent ledger, and meeting roles. These are prerequisites for recording and trustworthy meeting intelligence.
2. Change long summaries and document analysis to durable background jobs with progress events, cached results, retries, and model fallback.
3. Add task review-before-save, normalized due dates/time zones, priority, deduplication, source links, assignment acceptance, and notifications.
4. Build a server-side calendar and Google/Outlook connectors using Free/Busy-only access first; add working hours, time zones, conflict detection, and confirmation.
5. Add ACL-filtered hybrid search across messages, transcript segments, and document chunks with exact citations.
6. Add a permission-aware proactive ranking service with confidence thresholds, cooldowns, user controls, explanations, and feedback.
7. Add a controlled web-search tool with domain/source policy, citations, privacy redaction, rate limits, and clear separation from private-source answers.
8. Add meeting recording through LiveKit Egress only after consent, retention, object storage, malware scanning, access control, and India-residency requirements are defined and verified.
