/**
 * MV3 service worker.
 *
 * The worker is torn down after ~30s idle and restarted on the next event, so
 * every listener is registered synchronously at module scope. A listener added
 * inside an `await` or a `.then()` would miss the event that woke the worker in
 * the first place — the classic MV3 failure where the omnibox works once and
 * then goes dead.
 */

import { lastRuleStatus, syncRules } from './lib/dnr';
import { activeKeywords, resolve, stripPassthrough, suggest } from './lib/resolve';
import { loadResolveContext, onStateChanged } from './lib/storage';
import { toNavigableUrl } from './lib/url';
import type { BgMessage, Command, ResolveResult, RuleStatus, Settings } from './lib/types';

const SUGGESTION_LIMIT = 6;

const IDLE_HINT = 'BunnyLol <dim>— type a shortcut, e.g.</dim> <match>gh facebook/react</match>';

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

// ------------------------------------------------------------ listeners ----

// Dynamic rules survive restarts, so there is no need to re-sync on every
// wake — but the extension id changes on every load-unpacked, which would
// leave the redirects pointing at a dead origin. onInstalled covers that.
chrome.runtime.onInstalled.addListener(() => {
  void syncRules();
});

chrome.runtime.onStartup.addListener(() => {
  void syncRules();
});

// Adding or renaming a shortcut has to start intercepting it immediately,
// otherwise the user tests their new keyword and thinks it is broken.
onStateChanged(() => {
  void syncRules();
});

chrome.omnibox.setDefaultSuggestion({ description: IDLE_HINT });

chrome.omnibox.onInputChanged.addListener((text, respond) => {
  offerSuggestions(text, respond).catch((err) => {
    console.error('[bunnylol] suggestion failed', err);
  });
});

chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  navigate(text, disposition).catch((err) => {
    console.error('[bunnylol] navigation failed', err);
  });
});

chrome.runtime.onMessage.addListener((message: BgMessage, _sender, sendResponse) => {
  switch (message?.type) {
    case 'resyncRules':
      // Returning `true` is what keeps the response channel open. It also has
      // to be returned from a *synchronous* listener: an `async` listener
      // returns a Promise, which Chrome reads as "no response" and closes the
      // channel before `sendResponse` ever runs.
      syncRules().then(sendResponse, (err: unknown) => sendResponse(failedStatus(err)));
      return true;
    case 'getRuleStatus':
      readRuleStatus().then(sendResponse, (err: unknown) => sendResponse(failedStatus(err)));
      return true;
    case 'getExtensionId':
      sendResponse(chrome.runtime.id);
      return false;
    default:
      return false;
  }
});

// -------------------------------------------------------------- helpers ----

async function offerSuggestions(
  text: string,
  respond: (results: chrome.omnibox.SuggestResult[]) => void,
): Promise<void> {
  const { commands, settings } = await loadResolveContext();
  const result = resolve(text, commands, settings);
  chrome.omnibox.setDefaultSuggestion({ description: describeDefault(text, result) });

  const args = splitArgs(text);
  const keyword = splitKeyword(text);
  const results: chrome.omnibox.SuggestResult[] = [];

  // One extra candidate, because the command shown in the default row is
  // dropped from the list rather than repeated.
  for (const cmd of suggest(text, commands, SUGGESTION_LIMIT + 1)) {
    if (cmd === result.command) continue;
    results.push(describeCommand(cmd, keyword, args, commands, settings));
    if (results.length >= SUGGESTION_LIMIT) break;
  }
  respond(results);
}

async function navigate(
  text: string,
  disposition: chrome.omnibox.OnInputEnteredDisposition,
): Promise<void> {
  const { commands, settings } = await loadResolveContext();
  const url = toNavigableUrl(resolve(text, commands, settings).url);

  if (disposition === 'newForegroundTab' || disposition === 'newBackgroundTab') {
    await chrome.tabs.create({ url, active: disposition === 'newForegroundTab' });
    return;
  }
  try {
    // No tabId: updates the active tab of the current window.
    await chrome.tabs.update({ url });
  } catch {
    // No active tab to reuse — a new tab beats dropping the navigation.
    await chrome.tabs.create({ url, active: true });
  }
}

/**
 * Reports what is actually registered plus the error the last sync recorded.
 * Re-deriving the counts here and calling the error `null` is what let a
 * partial sync failure ("skipped N rules", a quota error) repaint the options
 * page pill green on the next poll.
 */
async function readRuleStatus(): Promise<RuleStatus> {
  const extensionId = chrome.runtime.id;
  try {
    const [rules, last] = await Promise.all([
      chrome.declarativeNetRequest.getDynamicRules(),
      lastRuleStatus(),
    ]);
    // The live rule list wins over the remembered count — another window may
    // have synced since — but everything else comes from that sync.
    if (last) return { ...last, registered: rules.length, extensionId };

    const { commands, settings } = await loadResolveContext();
    const keywords = activeKeywords(commands, settings.interceptStopList).length;
    const synced = rules.length > 0;
    return {
      registered: rules.length,
      // Without a remembered sync there is no honest coverage number — the
      // regexes would have to be parsed back apart — so eligible-or-nothing is
      // the closest true statement.
      keywords: synced ? keywords : 0,
      suppressed: activeKeywords(commands).length - keywords,
      dropped: synced ? 0 : keywords,
      // No sync has run in this browser session, so an empty rule list is a
      // real problem rather than a configuration the user chose.
      error: !synced && keywords > 0 ? 'Rules have not been synced yet.' : null,
      extensionId,
    };
  } catch (err) {
    return failedStatus(err);
  }
}

function failedStatus(err: unknown): RuleStatus {
  return {
    registered: 0,
    keywords: 0,
    suppressed: 0,
    dropped: 0,
    error: describeError(err),
    extensionId: chrome.runtime.id,
  };
}

/** The first row of the dropdown: what Enter on the raw text will actually do. */
function describeDefault(text: string, result: ResolveResult): string {
  const typed = text.trim();
  if (!typed) return IDLE_HINT;

  const target = `<url>${escapeXml(prettyUrl(result.url))}</url>`;
  if (!result.command) {
    return `<match>${escapeXml(typed)}</match> <dim>— search</dim> ${target}`;
  }
  return `<match>${escapeXml(typed)}</match> <dim>— ${escapeXml(result.command.name)}</dim> ${target}`;
}

function describeCommand(
  cmd: Command,
  keyword: string,
  args: string,
  commands: Command[],
  settings: Settings,
): chrome.omnibox.SuggestResult {
  const alias = pickAlias(cmd, keyword);
  // `content` is what lands back in the omnibox and what onInputEntered gets,
  // so it must be something `resolve()` understands: keyword plus arguments.
  const content = args ? `${alias} ${args}` : alias;
  const preview = prettyUrl(resolve(content, commands, settings).url);
  const label = cmd.name || alias;

  return {
    content,
    description:
      `<match>${escapeXml(content)}</match>` +
      ` <dim>— ${escapeXml(label)}</dim>` +
      ` <url>${escapeXml(preview)}</url>`,
  };
}

/** Prefers the alias the user is already typing, so the text does not jump. */
function pickAlias(cmd: Command, keyword: string): string {
  const aliases = (cmd.keys ?? []).map((key) => key.trim()).filter((key) => key.length > 0);
  const typed = keyword.toLowerCase();
  const matched = typed
    ? aliases.find((alias) => alias.toLowerCase().startsWith(typed))
    : undefined;
  return matched ?? aliases[0] ?? '';
}

function splitKeyword(text: string): string {
  const trimmed = text.trim();
  const boundary = trimmed.search(/\s/);
  return boundary < 0 ? trimmed : trimmed.slice(0, boundary);
}

function splitArgs(text: string): string {
  const trimmed = text.trim();
  const boundary = trimmed.search(/\s/);
  return boundary < 0 ? '' : trimmed.slice(boundary + 1).trim();
}

function prettyUrl(url: string): string {
  // The passthrough marker is plumbing; showing `&blpass=1` in every fallback
  // preview would just look like a bug to the user.
  return stripPassthrough(url).replace(/^https?:\/\//, '');
}

/** Chrome silently drops a suggestion whose description is not well-formed XML. */
function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
