/**
 * Folding an import onto the state already here.
 *
 * Pure, so the confirmation copy in the options page can be built from a plan
 * the tests can inspect: an import that changes something the dialog did not
 * name is the failure this module exists to prevent. Every reported field is
 * computed from the merge itself rather than from the incoming file, so the
 * dialog cannot name a change the merge then throws away, or stay quiet about
 * one it makes.
 *
 * OURS WIN on every collision. An import is somebody's backup being folded into
 * a profile that is already in use, so the rule is that nothing already here
 * changes value: the file fills gaps, and where it disagrees it is renamed,
 * re-minted or dropped rather than allowed to overwrite.
 */

import type { Command, Overrides, Section, ShortcutEdit } from './types';
import {
  MAX_SECTIONS,
  firstKey,
  fitSectionId,
  foldLabel,
  isShippedSection,
  isUserId,
  mintUserId,
  sectionLabel,
  shortcutId,
} from './overrides';

export interface MergePlan {
  overrides: Overrides;
  added: Command[];
  renames: { from: string; to: string }[];
  duplicates: string[];
  /** Shortcuts the file turns off that are still on here. */
  disables: string[];
  /** Shipped shortcuts the file deletes that are still here. */
  deletes: string[];
  /** Shipped shortcuts the file rebinds that carry no rebinding of yours. */
  rebinds: string[];
  /** Shipped shortcuts the file changes some other way, in a field we do not
   *  already edit ourselves: a repointed url, a rename. */
  edits: string[];
  /** The sections the merge adds, including any it had to rename. Labels are
   *  carried alongside the ids because the id is an internal slug and the
   *  dialog names groups the way the browse list does. */
  sections: Section[];
  /** The sections the merge could not add because this profile is at
   *  `MAX_SECTIONS`. Never added to `overrides.sections`: the save would drop
   *  them again and the dialog would have promised a group that never appears. */
  sectionsRefused: Section[];
  /** The onboarding pick the merge adopted from the file, set only when this
   *  profile had none of its own. Absent means yours was kept. */
  enabledCategories?: string[];
}

/**
 * Adds an import's shortcuts to the ones already here. Neither side is ever
 * dropped: an incoming alias that is already taken is renamed (`gh` -> `gh2`)
 * and reported, and an incoming shortcut identical to one of ours is skipped
 * rather than duplicated.
 */
export function mergeOverrides(current: Overrides, incoming: Overrides): MergePlan {
  const taken = new Set<string>();
  const mine = new Map<string, Command>();
  for (const cmd of current.custom) {
    for (const key of cmd.keys) {
      taken.add(key);
      if (!mine.has(key)) mine.set(key, cmd);
    }
  }

  const added: Command[] = [];
  const renames: { from: string; to: string }[] = [];
  const duplicates: string[] = [];

  // Sections FIRST: a category is an id resolved against them, so a section the
  // merge had to rename has to be renamed everywhere that names it before
  // anything is filed.
  const sectionMerge = mergeSections(current.sections, incoming.sections);
  const moved = sectionMerge.renamed;

  // Edits merge FIELD by field, not entry by entry: ours win per field, and an
  // incoming rebind of a shortcut we renamed survives instead of being dropped
  // whole because our entry happened to exist.
  // Null-prototype for the same reason the storage boundary uses one: an id is
  // a key off an import file, and `edits['__proto__']` on a plain object is
  // swallowed by the inherited setter.
  const edits: Record<string, ShortcutEdit> = Object.create(null);
  const rebinds: string[] = [];
  const edited: string[] = [];
  for (const id of new Set([...Object.keys(current.edits), ...Object.keys(incoming.edits)])) {
    const theirs = refileEdit(incoming.edits[id], moved);
    const ours = current.edits[id];
    edits[id] = { ...theirs, ...ours };
    // Exactly the fields the incoming entry contributes: what `{...theirs,
    // ...ours}` kept from theirs.
    const carried = Object.keys(theirs ?? {}).filter((field) => !(field in (ours ?? {})));
    if (carried.includes('keys')) rebinds.push(id);
    // Rebinds get their own sentence, so this one counts the rest: otherwise a
    // single incoming edit is announced twice.
    if (carried.some((field) => field !== 'keys')) edited.push(id);
  }

  // Ids, not just aliases: two shortcuts merged onto one id would share an
  // `edits`/`disabled` entry, and the second would inherit the first's history.
  const ids = new Set<string>();
  for (const cmd of current.custom) {
    const id = shortcutId(cmd);
    if (id) ids.add(id);
  }

  // Incoming shortcut id -> the id it ended up with here, so the file's
  // `disabled` and `deleted` entries follow their shortcut instead of landing
  // on ours: two profiles that each minted `u:jira` disagree about which
  // shortcut that names, and an unmapped union switches OURS off and leaves
  // theirs on. First writer wins, matching the pass below.
  const landedAs = new Map<string, string>();
  const land = (claimed: string, id: string): void => {
    if (claimed && id && !landedAs.has(claimed)) landedAs.set(claimed, id);
  };

  for (const cmd of incoming.custom) {
    const twin = mine.get(firstKey(cmd));
    if (twin && signatureOf(twin) === signatureOf(cmd)) {
      duplicates.push(firstKey(cmd));
      // Their entry IS ours now, so anything the file says about it has to
      // reach the shortcut that survived, which is not necessarily the one
      // their id happens to name here.
      land(shortcutId(cmd), shortcutId(twin));
      continue;
    }
    const keys = cmd.keys.map((key) => {
      if (!taken.has(key)) {
        taken.add(key);
        return key;
      }
      let suffix = 2;
      while (taken.has(`${key}${suffix}`)) suffix += 1;
      const renamed = `${key}${suffix}`;
      taken.add(renamed);
      renames.push({ from: key, to: renamed });
      return renamed;
    });
    const claimed = shortcutId(cmd);
    const id = isUserId(claimed) && !ids.has(claimed) ? claimed : mintUserId(firstKey(cmd), ids);
    ids.add(id);
    land(claimed, id);
    added.push({ ...cmd, id, keys, category: refile(cmd.category, moved) });
  }

  // Read through the remap, not off the file: an entry naming an id we had to
  // re-mint is about THEIR shortcut, and applying it to the id as written would
  // switch off ours and leave theirs on.
  const theirDisabled = [...new Set(incoming.disabled.map((id) => landedAs.get(id) ?? id))];
  const theirDeleted = [...new Set(incoming.deleted.map((id) => landedAs.get(id) ?? id))];
  // What the non-`custom` halves of the merge actually change, so the
  // confirmation can name it instead of promising nothing else moves.
  const disabled = new Set(current.disabled);
  const disables = theirDisabled.filter((id) => !disabled.has(id));
  const removed = new Set(current.deleted);
  const deletes = theirDeleted.filter((id) => !removed.has(id));

  // An import is a shortcuts backup, not a re-onboarding: the pick already here
  // stands. A profile that never saw the picker has no answer of its own, so it
  // adopts the file's rather than staying on "never onboarded" forever.
  const adopted = current.enabledCategories === null ? incoming.enabledCategories : null;

  const plan: MergePlan = {
    overrides: {
      // Ours win on every collision; the import only fills the gaps.
      disabled: [...new Set([...current.disabled, ...theirDisabled])],
      deleted: [...new Set([...current.deleted, ...theirDeleted])],
      edits,
      sections: sectionMerge.sections,
      custom: [...current.custom, ...added],
      enabledCategories: adopted ?? current.enabledCategories,
      seenBuiltins: [...new Set([...current.seenBuiltins, ...incoming.seenBuiltins])],
    },
    added,
    renames,
    duplicates,
    disables,
    deletes,
    rebinds,
    edits: edited,
    sections: sectionMerge.added,
    sectionsRefused: sectionMerge.refused,
  };
  if (adopted) plan.enabledCategories = adopted;
  return plan;
}

export function signatureOf(cmd: Command): string {
  return `${cmd.url}\u0000${cmd.searchUrl ?? ''}\u0000${cmd.handler ?? ''}`;
}

interface SectionMerge {
  sections: Section[];
  /** Sections added by this merge, in the order they were added. */
  added: Section[];
  /** Sections the cap left no room for. */
  refused: Section[];
  /** Incoming id -> the id it had to be given here. */
  renamed: Map<string, string>;
}

/**
 * Ours keep their labels, and an incoming section we do not have is added, so
 * an imported shortcut's category still names a group that exists.
 *
 * An incoming id that already names a DIFFERENT group here is the one case
 * where adding it would silently merge two people's sections into one heading.
 * It is renamed to `<id>-2` instead, and the caller refiles its members: a
 * group called "Client work" arriving into a profile that already calls `work`
 * something else is two groups, not one.
 *
 * "Already names a group here" includes the SHIPPED ids, compared against the
 * label in EFFECT rather than the one in `ours`: an incoming `{id: 'dev', label:
 * 'Engineering'}` into a profile that never renamed Developer has no entry to
 * collide with, and adding it verbatim would rename a shipped group the user
 * never touched under the heading "adds 1 section".
 *
 * Both the suffix and the count are bounded by what the storage boundary will
 * keep: an id past `MAX_SECTION_ID_LENGTH` fails `validateSectionId` and a
 * section past `MAX_SECTIONS` is truncated, and either one is dropped on the
 * next save with its members falling back to "My shortcuts".
 */
function mergeSections(ours: Section[], theirs: Section[]): SectionMerge {
  const sections = [...ours];
  const byId = new Map(ours.map((section) => [section.id, section]));
  const added: Section[] = [];
  const refused: Section[] = [];
  const renamed = new Map<string, string>();

  const take = (section: Section): void => {
    if (sections.length >= MAX_SECTIONS) {
      refused.push(section);
      return;
    }
    byId.set(section.id, section);
    sections.push(section);
    added.push(section);
  };

  for (const section of theirs) {
    if (byId.has(section.id) || isShippedSection(section.id)) {
      // Same id, same name: one group, already here.
      if (foldLabel(sectionLabel(section.id, ours)) === foldLabel(section.label)) continue;
      let id = fitSectionId(section.id, '-2');
      for (let n = 3; byId.has(id); n += 1) id = fitSectionId(section.id, `-${n}`);
      const refiled = { id, label: section.label };
      // Mapped even when the cap refuses it: the members follow the section
      // they belong to, and filing them back under the id they collided with
      // would put them in OUR group under a heading we never agreed to.
      renamed.set(section.id, id);
      take(refiled);
      continue;
    }
    take(section);
  }
  return { sections, added, refused, renamed };
}

/** An incoming category, through whatever `mergeSections` had to call it. */
function refile(category: string, moved: Map<string, string>): string {
  return moved.get(category) ?? category;
}

function refileEdit(
  edit: ShortcutEdit | undefined,
  moved: Map<string, string>,
): ShortcutEdit | undefined {
  if (!edit?.category) return edit;
  const category = moved.get(edit.category);
  return category ? { ...edit, category } : edit;
}
