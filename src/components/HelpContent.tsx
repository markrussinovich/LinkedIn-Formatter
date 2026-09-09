// Shared help copy, grouped into sections. Rendered inside a <details> by
// HelpPanel (used by the browser extension) and inside a modal by HelpModal
// (used by the web app). `webApp` enables web-only sections (e.g. installing as a
// PWA) that don't apply to the LinkedIn extension.
export function HelpContent({ webApp = false }: { webApp?: boolean }) {
  return (
    <div className="help-sections">
      <section className="help-section">
        <h3>Previews &amp; customization</h3>
        <ul className="help-list">
          <li>
            Write once in the main editor. Each enabled platform shows a live preview with that platform's character
            limit, counting rule, and formatting applied.
          </li>
          <li>
            Edit inside a preview to customize it for that platform. The card shows a Customized badge and a re-sync
            button that drops the customization and follows the main draft again.
          </li>
          <li>
            Cards start expanded, showing the full post. Where a platform collapses long posts (LinkedIn), a
            Desktop/Mobile toggle and the "more…"/"less…" markers estimate the collapsed feed view — treat them as
            approximations, since cutoffs vary by device and layout.
          </li>
          <li>Previews are visual approximations; real feed-card rendering requires each platform's APIs this static app cannot call.</li>
        </ul>
      </section>

      <section className="help-section">
        <h3>AI assistant (optional)</h3>
        <ul className="help-list">
          <li>
            Open the gear icon to connect an LLM endpoint — Anthropic (Claude), Google Gemini, or any OpenAI-compatible
            endpoint that allows browser/CORS requests. Use Test connection to verify it works. Your API key is stored
            only in this browser.
          </li>
          <li>Ask the AI to write or improve the main draft from the bar above the editor.</li>
          <li>
            Give the AI material to use as its context with \"Reference sources for AI\": add a .txt/.md/.docx file or
            pasted text. Sources are context only — they're never posted. Click a pasted source to edit it inline; an
            untitled paste is named automatically when AI is configured.
          </li>
          <li>Use "Adapt with AI" on a card to rewrite the post for that platform on demand.</li>
          <li>
            With auto-fit on, any platform over its limit is rewritten automatically about 3 seconds after you stop
            typing (shown with an AI badge; re-sync drops it). Fitted versions are re-checked against the limit and
            regenerated if still too long.
          </li>
          <li>Add Style guidance in settings to steer the voice (e.g. "keep it light-hearted with a bit of humor").</li>
        </ul>
      </section>

      <section className="help-section">
        <h3>Per-platform formatting</h3>
        <ul className="help-list">
          <li>
            Newlines map 1:1 to the post, like LinkedIn's composer: press Enter for a new line and again for a blank
            line. The editor's spacing matches the previews exactly — blank lines come only from the empty lines you add.
          </li>
          <li>
            LinkedIn keeps styled Unicode (bold/italic/underline). X, Bluesky, Threads, Facebook, and Instagram show
            plain text, since styled Unicode counts against limits and hurts reach and screen-reader accessibility.
          </li>
          <li>X counts URLs as 23 and some characters as 2 (its count is an estimate); Bluesky counts by grapheme clusters; Instagram captions can't render clickable links.</li>
          <li>Bold, italic, and underline export as Unicode text on LinkedIn, not selectable font styling.</li>
          <li>Nested lists and blockquotes use non-breaking-space indentation because posts are plain text; dividers export as a plain line.</li>
          <li>Emoji stay as regular emoji; underline and strikethrough do not add combining marks to them. Strikethrough is experimental and may render differently across devices.</li>
          <li>Hashtags stay plain so platforms have the best chance to recognize them.</li>
          <li>Links export as readable text plus URL because custom pasted anchor text is not supported in posts.</li>
          <li>Pasted Markdown converts to formatted draft text for common inline styles, links, headings, fenced code, lists, blockquotes, and horizontal rules.</li>
        </ul>
      </section>

      <section className="help-section">
        <h3>Image &amp; URL previews</h3>
        <ul className="help-list">
          <li>
            Add one image below the editor when the post should include media. The image is session-only, replaces any
            previous image, and can be copied to your clipboard for pasting into a composer.
          </li>
          <li>
            Add URLs directly in the editor or in a platform-specific edit. The URL stays in that platform's text and
            counts against its limit (on X each URL counts as 23).
          </li>
          <li>
            When an image is selected, preview cards show that image instead of URL unfurls. Otherwise, platforms that
            support URL previews show the unfurl preview for the last URL in that platform's rendered text after a short
            typing pause.
          </li>
        </ul>
      </section>

      <section className="help-section">
        <h3>Mentions</h3>
        <ul className="help-list">
          <li>
            Mention people as @[Name], for example @[Scott Hanselman]. The editor shows the token as plain text. On
            LinkedIn the preview shows it as @Scott Hanselman; on X, Bluesky, Threads, and Mastodon it collapses to a
            single handle-style token (@ScottHanselman) so their autocomplete fires on the whole name instead of
            splitting it at the space.
          </li>
          <li>
            Posting through the extension resolves each @[Name] through LinkedIn's mention typeahead into a real,
            clickable mention. Only an exact name match is used; if nothing matches, the text stays plain @Name rather
            than mentioning the wrong person.
          </li>
          <li>
            Copy can't produce a real mention — pasted text never does. To mention after pasting, type "@" in the
            platform's composer and pick the person from the dropdown.
          </li>
        </ul>
      </section>

      <section className="help-section">
        <h3>Copying &amp; posting</h3>
        <ul className="help-list">
          <li>
            Each preview card has Copy (platform-ready text) and, where supported, Copy &amp; open, which copies and
            opens that platform's composer (pre-filled on X, Bluesky, and Threads). Facebook and Instagram are
            copy-only or open to the site, since they don't accept pre-filled caption text.
          </li>
          <li>
            When posting through the extension, LinkedIn expands the last URL into its usual link preview card. Attached
            images or video suppress the preview, as on LinkedIn itself.
          </li>
        </ul>
      </section>

      <section className="help-section">
        <h3>Drafts &amp; shortcuts</h3>
        <ul className="help-list">
          <li>Saved drafts (including per-platform customizations and your enabled platforms) are local to this browser only.</li>
          <li>Keyboard shortcuts include Ctrl+B, Ctrl+I, Ctrl+Z, and Ctrl+Y, and work in both the main editor and the platform previews.</li>
        </ul>
      </section>

      {webApp ? (
        <section className="help-section">
          <h3>Install as an app (PWA)</h3>
          <ul className="help-list">
            <li>
              Polypost is a Progressive Web App. Use the Install app button in the header — or your browser's install
              option — to add it to your home screen or desktop and run it in its own window.
            </li>
            <li>
              Works offline: once it has loaded, you can open Polypost and write, edit, and manage drafts with no
              connection. AI assistance and link previews need the network, so they're unavailable offline.
            </li>
            <li>
              Stays up to date: when a new version is published, a "new version available" prompt appears — reload to
              update.
            </li>
            <li>An attached image or video is saved on this device, so it's restored when you reopen the app.</li>
          </ul>
        </section>
      ) : null}
    </div>
  );
}
