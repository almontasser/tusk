// Navigate Back and Forward, as PhpStorm has them: the places the cursor jumped from, and the file names that pair a
// class with its test. Monaco-free, so the tests can load it.

export type Place = { path: string; line: number; column: number };

const LIMIT = 50;

/** Whether a cursor move is worth going back to: into another file, or more than 10 lines away. */
export const isJump = (from: Place, to: Place) => from.path !== to.path || Math.abs(from.line - to.line) > 10;

/** Back and forward stacks of places, most recent last. */
export class Places {
  back: Place[] = [];
  forward: Place[] = [];

  /** Remembers a place the cursor jumped from. A new jump drops the places you went back from. */
  push(from: Place) {
    const last = this.back.at(-1);
    if (!last || last.path !== from.path || last.line !== from.line) this.back = [...this.back, from].slice(-LIMIT);
    this.forward = [];
  }

  /** The place to go back to from `current`, skipping places on its line; `current` goes onto the forward stack. */
  goBack(current: Place | undefined) {
    return step(this.back, this.forward, current);
  }

  goForward(current: Place | undefined) {
    return step(this.forward, this.back, current);
  }

  clear() {
    this.back = [];
    this.forward = [];
  }
}

function step(from: Place[], to: Place[], current: Place | undefined) {
  while (from.length && current && from.at(-1)!.path === current.path && from.at(-1)!.line === current.line) from.pop();
  const place = from.pop();
  const top = to.at(-1);
  if (place && current && !(top?.path === current.path && top.line === current.line)) to.push(current), to.length > LIMIT && to.shift();
  return place;
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The file that pairs with `path`: `UserTest.php` for `User.php`, and `User.php` for `UserTest.php`. */
export function testPartner(path: string) {
  const m = /^(.+?)(Test)?\.php$/.exec(baseName(path));
  return m ? (m[2] ? `${m[1]}.php` : `${m[1]}Test.php`) : undefined;
}

/** The project files, relative to the root, that pair with `path`, leaving out `vendor`. */
export const testPartners = (path: string, files: string[]) => {
  const name = testPartner(path);
  return name ? files.filter((f) => !f.startsWith("vendor/") && baseName(f) === name) : [];
};
