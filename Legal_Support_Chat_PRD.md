# Legal-tech customer support chat
## Product requirements · Hiring assignment

A customer of a fictional legal-tech platform can ask how the service works, bring an agreement into the same conversation, and check the passage behind each answer. A hiring reviewer should be able to sign up, try a suggested question, and verify the answer against a starter document without configuring the knowledge base.

## Customer experience and decision rationale

| Decision | User experience | Reason and trade-off |
|---|---|---|
| Ground answers in business documents | Start with a few question pills, such as “How do I export my contracts?” Retrieve evidence from the shared help guides and policies. | A concrete support question demonstrates the assignment and gives the reviewer a way to judge answer quality. Starter documents must agree with the questions offered. |
| Serve one organization | All customers can use the same published knowledge base. Each account owns its conversations. | Multiple organizations fall outside the hiring brief. One organization leaves more time for retrieval, citations, and testing. |
| Scope uploads to a conversation | Attach a PDF or text file. Reopen the conversation to ask follow-ups using that file. A fresh chat sees only shared documents until the user attaches files. | This matches the expectation that a file stays where it was shared. Reuse in another conversation requires another upload. |
| Start fresh after login | Show a fresh composer and suggested questions in the center, with previous chats in a left sidebar. Selecting a chat restores its messages, attachments, citations, and comparison results. | New issues start with clean context. A returning customer can resume an old issue in one click. |
| Put evidence beside each claim | Link the sentence or paragraph to its source. Hover previews the passage. Clicking opens the cited PDF page or text passage. | A user can check the wording quickly and inspect the surrounding terms when needed. Each link must identify the document version and location. |
| Handle incomplete evidence explicitly | Answer supported parts, identify the unresolved question, and offer to draft a support email. On acceptance, provide a draft the user can review, copy, and send. | The user leaves with a practical next step and controls what they share. Delivery remains a separate action. |
| Compare clauses with Google A2UI | When asked what changed between an attached agreement and amendment, the assistant selects a clause comparison component. Show each term with both passages and their citations. Identify a missing passage explicitly. | The reviewer can verify differences side by side. One component gives the framework a specific purpose and keeps the rendering work bounded. |
| Stream prose and present complete comparisons | Show the submitted question immediately and a typing or progress indicator during retrieval. Stream prose as it becomes available. Show a comparison once its rows and citations are ready. | Readers can start on longer answers early. Complete cards prevent one side of a comparison from appearing to be the whole result. Interrupted prose must be identifiable. |

**Visual direction for review.** The sidebar and fresh-chat behavior are agreed. A ChatGPT-style reading area is recommended for the remaining visual design. Give cited paragraphs and comparisons the width of the answer column. On a narrow screen, a proposed adaptation is to collapse history into a drawer and stack both passages under each comparison term. Keep source links usable by touch and keyboard.

## Administrator experience

Include a starter pack and a dedicated admin screen for adding and managing shared PDFs and text files. Show each file’s indexing status (queued, indexing, ready, or failed). Ready means customers can retrieve and cite it. A failed item shows the reason and offers retry. Restrict shared-document management to admins. Customer uploads remain confined to their own chats.

When replacing a policy, keep the existing version active until its replacement is ready. Then use the replacement for new answers. Earlier citations continue to open the original page or passage, labeled Superseded. This preserves the evidence for historical answers and keeps a failed upload from interrupting support.

## Assignment and release requirements

| Area | Requirement | Purpose |
|---|---|---|
| Authentication | Signup, login, and logout using JWT, bcrypt password hashing, secure token handling, and protected routes. | Keep accounts and private conversations separate. |
| Chat and persistence | React client using Fetch or Axios, Node.js and Express server, and user-scoped history in MongoDB Atlas. Include /auth/signup, /auth/login, /chat/send, and /chat/history. | Meet the full-stack brief and restore the conversation across sessions. |
| AI | Integrate a supported provider or free-tier-compatible model. Select the provider, retrieval approach, and streaming transport in the TRD. | The PRD defines what an answer must do so implementation choices can be evaluated against it. |
| All three bonuses | Typing indicator, rate limiting with express-rate-limit, and separate development and production configuration. | Give feedback while waiting, handle usage limits, and support local and hosted runs. |
| Failure recovery | Show when a rate-limited user can retry. Preserve the question and attachments after a failed reply. Retry without duplicating the user message. | A temporary failure should not require recreating a legal-document question. |
| Handoff | GitHub repository with client/ and server/, example environment files, and clear README setup steps. Dockerize the app, support docker compose up after documented configuration, and provide a working deployed link and demo video. | Reviewers can try the hosted experience, reproduce it locally, and inspect the framework integration. |

## Acceptance and demo

1. Sign up on the deployed app. Select a suggested question, watch the answer stream, preview an inline citation, and open the exact passage.
2. Attach an agreement and amendment containing a known change. Ask what changed. Show the complete comparison and inspect both source pages. In the video, identify Google A2UI and briefly show how the agent’s response selects the React component.
3. Ask about a term absent from the available documents. Confirm the assistant identifies the gap and can draft a support email.
4. Start a fresh chat and confirm the prior attachments are outside its scope. Reopen the earlier chat and continue using its attachments. Verify a second account cannot open the first account’s history or private sources.
5. As an admin, upload a revised shared policy. Observe indexing status, then verify a new answer cites the revision while an old citation opens the superseded version. Verify a customer cannot manage shared files.
6. Exercise a failed reply and a rate-limited request. Verify clear feedback and retry behavior. Verify logout protects the chat views and that the documented Compose startup works.

## Deferred work

Multi-tenancy is eligible for reconsideration only if the required features, all three bonuses, and deployment are complete with time to spare. Separate organizations would require membership and document isolation beyond the brief. In-app email sending is future scope because delivery would require an integration and reliable delivery feedback. The initial release ends with the copyable draft.
