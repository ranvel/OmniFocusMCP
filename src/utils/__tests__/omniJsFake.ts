/**
 * A small fake of the slice of Omni Automation the write payloads touch:
 * tasks with parent/children, projects whose top level is a root task, folders,
 * tags, the inbox, the flattened collections, constructors, moveTasks /
 * moveSections / deleteObject, and the enums. Behaviors modelled on what was
 * observed live (OmniFocus 4.9.3):
 *
 * - `byName` on the flattened arrays is case-sensitive.
 * - A project's id equals its root task's id; `Task.byIdentifier(projectId)`
 *   is the root task and `Project.byIdentifier(projectId)` the project.
 * - `markComplete()` / `drop(false)` on a repeating task clone the occurrence
 *   (`<id>.0`, completed / dropped) and keep the ORIGINAL id on the live one.
 * - `Task.dropped` does not exist; `dropDate` and `taskStatus` do.
 * - `reviewInterval` reads back as a copy, accepts only a ReviewInterval, and
 *   an unknown unit silently resets steps to 1 and keeps the old unit.
 * - `Project.markReviewed` does not exist; `lastReviewDate` / `nextReviewDate`
 *   are assignable.
 */

export type Loc = { container: FakeTask | null; index: (t: FakeTask) => number };
export type FolderLoc = { folder: FakeFolder | null };

class Enum {
  constructor(public readonly name: string) {}
  toString() { return this.name; }
}

export class RepetitionRule {
  constructor(
    public ruleString: string,
    public method: unknown,
    public scheduleType: unknown,
    public anchorDateKey: unknown,
    public catchUpAutomatically: boolean
  ) {}
}

export class ReviewInterval {
  constructor(public steps: number, public unit: string) {}
}

export class FakeTag {
  id: { primaryKey: string };
  children: FakeTag[] = [];
  constructor(public name: string, public parent: FakeTag | null, id: string) {
    this.id = { primaryKey: id };
  }
}

export class FakeFolder {
  id: { primaryKey: string };
  folders: FakeFolder[] = [];
  projects: FakeProject[] = [];
  constructor(public name: string, public parent: FakeFolder | null, id: string) {
    this.id = { primaryKey: id };
  }
  get ending(): FolderLoc { return { folder: this }; }
  get beginning(): FolderLoc { return { folder: this }; }
}

export class FakeTask {
  id: { primaryKey: string };
  note = '';
  dueDate: Date | null = null;
  deferDate: Date | null = null;
  plannedDate: Date | null = null;
  flagged = false;
  estimatedMinutes: number | null = null;
  sequential = false;
  parent: FakeTask | null = null;
  children: FakeTask[] = [];
  /** Set only on a project's root task. */
  project: FakeProject | null = null;
  tags: FakeTag[] = [];
  completed = false;
  completionDate: Date | null = null;
  dropDate: Date | null = null;
  private _rule: RepetitionRule | null = null;

  constructor(public name: string, id: string, private readonly world: World) {
    this.id = { primaryKey: id };
  }

  get repetitionRule(): RepetitionRule | null { return this._rule; }
  set repetitionRule(r: RepetitionRule | null) {
    this._rule = r;
    this.world.ruleTamper?.(r);
  }

  get inInbox(): boolean {
    return this.parent === null && this.world.inboxList.includes(this) && !this.project;
  }
  get containingProject(): FakeProject | null {
    let a: FakeTask | null = this;
    while (a) {
      if (a.project) return a.project;
      a = a.parent;
    }
    return null;
  }
  get taskStatus(): Enum {
    if (this.completed) return STATUS.Completed;
    if (this.dropDate) return STATUS.Dropped;
    return STATUS.Available;
  }
  get beginning(): Loc { return { container: this, index: () => 0 }; }
  get ending(): Loc {
    return { container: this, index: (m) => this.children.filter(c => c !== m).length };
  }
  get before(): Loc {
    return {
      container: this.parent,
      index: (m) => this.world.listOf(this.parent).filter(c => c !== m).indexOf(this),
    };
  }
  get after(): Loc {
    return {
      container: this.parent,
      index: (m) => this.world.listOf(this.parent).filter(c => c !== m).indexOf(this) + 1,
    };
  }

  addTag(tag: FakeTag) { if (!this.tags.includes(tag)) this.tags.push(tag); }
  addTags(tags: FakeTag[]) { tags.forEach(t => this.addTag(t)); }
  removeTag(tag: FakeTag) { this.tags = this.tags.filter(t => t !== tag); }
  removeTags(tags: FakeTag[]) { tags.forEach(t => this.removeTag(t)); }
  clearTags() { this.tags = []; }

  /** Repeating: clone the occurrence as done, keep this id live. */
  private cloneOccurrence(): FakeTask {
    const clone = this.world.task(this.name, this.parent, `${this.id.primaryKey}.${this.world.cloneSeq++}`);
    clone.repetitionRule = this._rule;
    const sibs = this.world.listOf(this.parent);
    sibs.splice(sibs.indexOf(clone), 1);
    sibs.splice(sibs.indexOf(this), 0, clone);
    return clone;
  }
  markComplete(date?: Date | null): FakeTask {
    if (this.completed) return this;
    if (this._rule) {
      const clone = this.cloneOccurrence();
      clone.completed = true;
      clone.completionDate = date ?? this.world.now();
      return clone;
    }
    this.completed = true;
    this.completionDate = date ?? this.world.now();
    return this;
  }
  markIncomplete() {
    this.completed = false;
    this.completionDate = null;
    this.dropDate = null;
  }
  drop(allOccurrences: boolean) {
    if (this._rule && !allOccurrences) {
      const clone = this.cloneOccurrence();
      clone.dropDate = this.world.now();
      return;
    }
    this.dropDate = this.world.now();
    // Dropping a project's root task drops the project (observed live).
    if (this.project) this.project.status = PSTATUS.Dropped;
  }
}

export class FakeProject {
  id: { primaryKey: string };
  task: FakeTask;
  status: Enum = PSTATUS.Active;
  parentFolder: FakeFolder | null = null;
  lastReviewDate: Date | null = null;
  nextReviewDate: Date | null = null;
  private _interval = new ReviewInterval(1, 'weeks');
  validUnits = ['days', 'weeks', 'months', 'years'];

  constructor(name: string, id: string, private readonly world: World) {
    this.id = { primaryKey: id };
    this.task = new FakeTask(name, id, world);
    this.task.project = this;
    world.tasks.push(this.task);
    world.byId.set(id, this.task);
  }

  get name() { return this.task.name; }
  set name(v: string) { this.task.name = v; }
  get note() { return this.task.note; }
  set note(v: string) { this.task.note = v; }
  get dueDate() { return this.task.dueDate; }
  set dueDate(v: Date | null) { this.task.dueDate = v; }
  get deferDate() { return this.task.deferDate; }
  set deferDate(v: Date | null) { this.task.deferDate = v; }
  get plannedDate() { return null; }
  get flagged() { return this.task.flagged; }
  set flagged(v: boolean) { this.task.flagged = v; }
  get estimatedMinutes() { return this.task.estimatedMinutes; }
  set estimatedMinutes(v: number | null) { this.task.estimatedMinutes = v; }
  get sequential() { return this.task.sequential; }
  set sequential(v: boolean) { this.task.sequential = v; }
  get tags() { return this.task.tags; }
  get repetitionRule() { return this.task.repetitionRule; }
  set repetitionRule(r: RepetitionRule | null) { this.task.repetitionRule = r; }
  get completed() { return this.status === PSTATUS.Done; }
  get children() { return this.task.children; }
  get tasks() { return this.task.children; }
  /** Every task in the project, depth first. */
  get flattenedTasks(): FakeTask[] {
    const out: FakeTask[] = [];
    const walk = (ts: FakeTask[]) => ts.forEach(t => { out.push(t); walk(t.children); });
    walk(this.task.children);
    return out;
  }
  get beginning(): Loc { return this.task.beginning; }
  get ending(): Loc { return this.task.ending; }

  get reviewInterval(): ReviewInterval {
    return new ReviewInterval(this._interval.steps, this._interval.unit);
  }
  set reviewInterval(v: ReviewInterval) {
    if (!(v instanceof ReviewInterval)) throw new Error('requires a Project.ReviewInterval');
    this._interval = this.validUnits.includes(v.unit)
      ? new ReviewInterval(v.steps, v.unit)
      : new ReviewInterval(1, this._interval.unit);
  }

  addTag(tag: FakeTag) { this.task.addTag(tag); }
  addTags(tags: FakeTag[]) { this.task.addTags(tags); }
  removeTag(tag: FakeTag) { this.task.removeTag(tag); }
  removeTags(tags: FakeTag[]) { this.task.removeTags(tags); }
  clearTags() { this.task.clearTags(); }
  markComplete() { this.status = PSTATUS.Done; this.task.completed = true; return this.task; }
  markIncomplete() { this.status = PSTATUS.Active; this.task.completed = false; this.task.dropDate = null; }
}

const STATUS = {
  Available: new Enum('Available'),
  Blocked: new Enum('Blocked'),
  Completed: new Enum('Completed'),
  Dropped: new Enum('Dropped'),
  DueSoon: new Enum('DueSoon'),
  Next: new Enum('Next'),
  Overdue: new Enum('Overdue'),
};
const PSTATUS = {
  Active: new Enum('Active'),
  Done: new Enum('Done'),
  Dropped: new Enum('Dropped'),
  OnHold: new Enum('OnHold'),
};
const ANCHOR = {
  DeferDate: new Enum('DeferDate'),
  DueDate: new Enum('DueDate'),
  PlannedDate: new Enum('PlannedDate'),
};
const SCHEDULE = {
  Regularly: new Enum('Regularly'),
  FromCompletion: new Enum('FromCompletion'),
};

function withByName<T extends { name: string }>(arr: T[]): T[] {
  Object.defineProperty(arr, 'byName', {
    value: (name: string) => arr.find(x => x.name === name) ?? null,
    enumerable: false,
  });
  return arr;
}

export class World {
  byId = new Map<string, FakeTask>();
  projectsById = new Map<string, FakeProject>();
  inboxList: FakeTask[] = [];
  tasks = withByName<FakeTask>([]);
  projects = withByName<FakeProject>([]);
  folders = withByName<FakeFolder>([]);
  tags = withByName<FakeTag>([]);
  seq = 0;
  cloneSeq = 0;
  ruleTamper?: (r: RepetitionRule | null) => void;
  moveTamper?: (t: FakeTask) => void;
  now = () => new Date('2026-10-14T18:00:00');
  /** Set to false to simulate an OmniFocus older than 4.7. */
  anchorDateKeySupported = true;

  listOf(c: FakeTask | null): FakeTask[] {
    return c ? c.children : this.inboxList;
  }
  private nextId(prefix: string) {
    return `${prefix}${++this.seq}`;
  }

  // --- fixture builders -------------------------------------------------------
  folder(name: string, parent: FakeFolder | null = null, id = this.nextId('f')): FakeFolder {
    const f = new FakeFolder(name, parent, id);
    this.folders.push(f);
    (parent ? parent.folders : []).push(f);
    return f;
  }
  project(name: string, folder: FakeFolder | null = null, id = this.nextId('P')): FakeProject {
    const p = new FakeProject(name, id, this);
    p.parentFolder = folder;
    folder?.projects.push(p);
    this.projects.push(p);
    this.projectsById.set(id, p);
    return p;
  }
  /** `container`: a parent task, a project (its root task), or null for the inbox. */
  task(name: string, container: FakeTask | FakeProject | null, id = this.nextId('t')): FakeTask {
    const t = new FakeTask(name, id, this);
    const parent = container instanceof FakeProject ? container.task : container;
    this.listOf(parent).push(t);
    t.parent = parent;
    this.tasks.push(t);
    this.byId.set(id, t);
    return t;
  }
  tag(name: string, parent: FakeTag | null = null, id = this.nextId('g')): FakeTag {
    const g = new FakeTag(name, parent, id);
    parent?.children.push(g);
    this.tags.push(g);
    return g;
  }
  names(c: FakeTask | FakeProject | null): string[] {
    const parent = c instanceof FakeProject ? c.task : c;
    return this.listOf(parent).map(t => t.id.primaryKey);
  }

  // --- database functions -----------------------------------------------------
  moveTasks = (tasks: FakeTask[], loc: Loc | FakeTask | FakeProject) => {
    const L: Loc = loc instanceof FakeProject ? loc.ending : loc instanceof FakeTask ? loc.ending : loc;
    for (const t of tasks) {
      for (let a: FakeTask | null = L.container; a; a = a.parent) {
        if (a === t) throw new Error('Parent not valid.');
      }
      const i = L.index(t);
      const from = this.listOf(t.parent);
      from.splice(from.indexOf(t), 1);
      this.listOf(L.container).splice(i, 0, t);
      t.parent = L.container;
      this.moveTamper?.(t);
    }
  };
  moveSections = (sections: Array<FakeProject | FakeFolder>, loc: FolderLoc | FakeFolder) => {
    const folder = loc instanceof FakeFolder ? loc : loc.folder;
    for (const s of sections) {
      if (s instanceof FakeProject) {
        if (s.parentFolder) s.parentFolder.projects = s.parentFolder.projects.filter(p => p !== s);
        s.parentFolder = folder;
        folder?.projects.push(s);
      } else {
        if (s.parent) s.parent.folders = s.parent.folders.filter(f => f !== s);
        s.parent = folder;
        folder?.folders.push(s);
      }
    }
  };
  deleteObject = (obj: FakeTask | FakeProject | FakeFolder | FakeTag) => {
    const drop = <T>(arr: T[], x: T) => { const i = arr.indexOf(x); if (i >= 0) arr.splice(i, 1); };
    if (obj instanceof FakeTask) {
      [...obj.children].forEach(c => this.deleteObject(c));
      drop(this.listOf(obj.parent), obj);
      drop(this.tasks, obj);
      this.byId.delete(obj.id.primaryKey);
    } else if (obj instanceof FakeProject) {
      [...obj.task.children].forEach(c => this.deleteObject(c));
      drop(this.tasks, obj.task);
      this.byId.delete(obj.id.primaryKey);
      drop(this.projects, obj);
      this.projectsById.delete(obj.id.primaryKey);
      if (obj.parentFolder) drop(obj.parentFolder.projects, obj);
    } else if (obj instanceof FakeFolder) {
      [...obj.projects].forEach(p => this.deleteObject(p));
      [...obj.folders].forEach(f => this.deleteObject(f));
      drop(this.folders, obj);
      if (obj.parent) drop(obj.parent.folders, obj);
    } else {
      [...obj.children].forEach(c => this.deleteObject(c));
      drop(this.tags, obj);
      if (obj.parent) drop(obj.parent.children, obj);
      this.tasks.forEach(t => t.removeTag(obj));
    }
  };

  /** The globals a payload sees, keyed by the names it uses. */
  get globals(): Record<string, unknown> {
    const world = this;
    const Task: any = function (this: any, name: string, position?: Loc | FakeTask | FakeProject | null) {
      const loc: Loc = position == null
        ? world.inbox.ending
        : position instanceof FakeProject ? position.ending
        : position instanceof FakeTask ? position.ending
        : position;
      const t = world.task(name, null);
      world.inboxList.splice(world.inboxList.indexOf(t), 1);
      world.listOf(loc.container).splice(loc.index(t), 0, t);
      t.parent = loc.container;
      return t;
    };
    Task.byIdentifier = (id: string) => world.byId.get(id) ?? null;
    Task.Status = STATUS;
    Task.RepetitionRule = RepetitionRule;
    Task.RepetitionScheduleType = SCHEDULE;
    if (this.anchorDateKeySupported) Task.AnchorDateKey = ANCHOR;

    const Project: any = function (this: any, name: string, position?: FolderLoc | FakeFolder | null) {
      const folder = position == null ? null : position instanceof FakeFolder ? position : position.folder;
      return world.project(name, folder);
    };
    Project.byIdentifier = (id: string) => world.projectsById.get(id) ?? null;
    Project.Status = PSTATUS;
    Project.ReviewInterval = ReviewInterval;

    const Tag: any = function (this: any, name: string, position?: FakeTag | null) {
      return world.tag(name, position ?? null);
    };
    Tag.byIdentifier = (id: string) => world.tags.find(t => t.id.primaryKey === id) ?? null;

    const Folder: any = function (this: any, name: string, position?: FolderLoc | FakeFolder | null) {
      const parent = position == null ? null : position instanceof FakeFolder ? position : position.folder;
      return world.folder(name, parent);
    };
    Folder.byIdentifier = (id: string) => world.folders.find(f => f.id.primaryKey === id) ?? null;

    return {
      Task,
      Project,
      Tag,
      Folder,
      inbox: this.inbox,
      flattenedTasks: this.tasks,
      flattenedProjects: this.projects,
      flattenedFolders: this.folders,
      flattenedTags: this.tags,
      moveTasks: this.moveTasks,
      moveSections: this.moveSections,
      deleteObject: this.deleteObject,
    };
  }

  private _inbox: any;
  get inbox(): any {
    if (this._inbox) return this._inbox;
    const list = this.inboxList;
    const inbox: any = {
      get length() { return list.length; },
      get beginning(): Loc { return { container: null, index: () => 0 }; },
      get ending(): Loc { return { container: null, index: (m: FakeTask) => list.filter(c => c !== m).length }; },
    };
    for (let i = 0; i < 200; i++) {
      Object.defineProperty(inbox, i, { get: () => list[i] });
    }
    this._inbox = inbox;
    return inbox;
  }
}

export function buildWorld(): World {
  return new World();
}

/**
 * The fixture the move tests were written against: P1 with A, B, C, D (A1
 * under A), P2 with X, and I1, I2 in the inbox.
 */
export function standardWorld() {
  const w = buildWorld();
  const P1 = w.project('Project One', null, 'P1');
  const P2 = w.project('Project Two', null, 'P2');
  const [A, B, C, D] = ['A', 'B', 'C', 'D'].map(n => w.task('Task ' + n, P1, n));
  const A1 = w.task('Task A1', A, 'A1');
  const X = w.task('Task X', P2, 'X');
  const I1 = w.task('Inbox One', null, 'I1');
  const I2 = w.task('Inbox Two', null, 'I2');
  return { w, P1, P2, A, B, C, D, A1, X, I1, I2 };
}
