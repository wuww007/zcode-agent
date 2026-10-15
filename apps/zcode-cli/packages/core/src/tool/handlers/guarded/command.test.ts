// Guarded 危险命令 matcher 契约（移植自官方 v3.15.1 tests/guarded-command.test.ts +
// guarded-deletion.test.ts，vitest → node:test）。纯断言、零 mock，可独立运行：
//   npx tsx --test apps/zcode-cli/packages/core/src/tool/handlers/guarded/command.test.ts
// 注意：core 的 tsconfig 排除 **/*.test.ts，本文件不进 tsc。

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { analyzeBashCommand } from "../bash-command-parser.js";
import { matchDangerousCommand } from "./command.js";
import { analyzeCmdCommand } from "./cmd.js";
import { optionTable, parseOptions } from "./options.js";
import { literalPosixWord } from "./word.js";

type Dialect = "posix" | "git-bash" | "cmd";

function expectMatched(command: string, dialect: Dialect, ruleId: string): void {
  assert.partialDeepStrictEqual(
    matchDangerousCommand(command, dialect),
    { status: "matched", ruleId },
    command,
  );
}

function expectStatus(command: string, dialect: Dialect, status: string): void {
  assert.equal(matchDangerousCommand(command, dialect).status, status, command);
}

function expectNotMatched(command: string, dialect: Dialect): void {
  assert.notEqual(matchDangerousCommand(command, dialect).status, "matched", command);
}

const MATCHES: ReadonlyArray<readonly [string, ...string[]]> = [
  [
    "remove-critical-path",
    "rm -rf build",
    "rm -f -R build",
    "rm --recursive --force build",
    'rm -rf "$target"',
    "rm -rf -- -i",
    "rm -rfi build",
  ],
  [
    "system-storage",
    "dd if=in of=out",
    "mount /dev/disk /mnt",
    "umount /mnt",
    "mkfs /dev/disk",
    "mkfs.ext4 /dev/disk",
  ],
  [
    "git-reset-hard",
    "git reset --hard",
    "git -C repo reset --hard HEAD",
    "git --git-dir=repo reset --hard",
  ],
  [
    "git-clean-force",
    "git clean -fd",
    "git clean -dfx",
    "git clean -f file",
    "git clean -f -- --dry-run",
  ],
  [
    "git-push-force",
    "git push -f origin main",
    "git push --force-with-lease",
    "git push --mirror",
    "git push origin +HEAD:main",
    "git push --force origin 'refs/heads/*:refs/heads/*'",
    "git push --force --no-dry-run",
    "git push --force-with-lease --no-force",
  ],
  [
    "git-discard-tree",
    "git checkout -f main",
    "git checkout HEAD -- .",
    "git restore .",
    "git restore --staged --worktree ./",
    "git restore --source=HEAD :/",
  ],
  ["git-stash-clear", "git stash clear"],
  ["git-worktree-force-remove", "git worktree remove -ff path", "git worktree remove --force path"],
  [
    "rsync-delete",
    "rsync -a --delete src/ dest/",
    "rsync --del src/ dest/",
    "rsync --delete-before src/ dest/",
    "rsync --delete-during src/ dest/",
    "rsync --delete-delay src/ dest/",
    "rsync --delete-after src/ dest/",
    "rsync --delete-excluded src/ dest/",
  ],
];

describe("Guarded finite command contract", () => {
  for (const dialect of ["posix", "git-bash", "cmd"] as const) {
    for (const command of [
      "git push origin +refs/heads/*:refs/heads/*",
      'git push origin "+refs/heads/*:refs/heads/*"',
      'git push origin "+main"',
      'git push --force origin "refs/heads/*:refs/heads/*"',
      "git push --repo origin +refs/heads/*:refs/heads/*",
    ]) {
      it(`recognizes force refspecs in ${dialect}: ${command}`, () => {
        expectMatched(command, dialect, "safety.bash.git-push-force");
      });
    }
    for (const command of [
      "git push --dry-run origin +refs/heads/*:refs/heads/*",
      "git push -n origin +refs/heads/*:refs/heads/*",
      "git push origin refs/heads/*:refs/heads/*",
      'git push --push-option "+refs/heads/*:refs/heads/*" origin main',
      'git push --repo "+refs/heads/*:refs/heads/*" main',
      'git push "+refs/heads/*:refs/heads/*" main',
    ]) {
      it(`preserves force refspec boundaries in ${dialect}: ${command}`, () => {
        expectNotMatched(command, dialect);
      });
    }
  }

  for (const [id, ...commands] of MATCHES) {
    for (const command of commands) {
      it(`${id}: ${command}`, () => {
        expectMatched(command, "posix", `safety.bash.${id}`);
      });
    }
  }

  for (const command of [
    "env A=b rm -rf build",
    "env -u A rm -rf build",
    "time -o file rm -rf build",
    "/usr/bin/time --output=file rm -rf build",
    "sudo -u root rm -rf build",
    "env -C repo time -f '%e' sudo --user=root rm -rf build",
    "echo hello; rm -rf build",
    "false || rm -rf build",
    "true && rm -rf build",
    "echo hi | rm -rf build",
    '"/bin/rm" -rf build',
    "r\\m -rf build",
    "for x in a; do echo hi; done; rm -rf build",
  ]) {
    it(`recognizes reliable command nodes: ${command}`, () => {
      expectMatched(command, "posix", "safety.bash.remove-critical-path");
    });
  }

  for (const command of [
    "rm -f file",
    "rm -- -rf",
    "rm --help",
    "rm --version",
    "mount",
    "dd --help",
    "mount --version",
    "mkfs --help",
    "git reset --soft HEAD",
    "git reset -- --hard",
    "git clean -nfd",
    "git clean -fd --dry-run",
    "git clean -fd -e --dry-run --dry-run",
    "git push -nf",
    "git push --force --no-force",
    "git push --force-if-includes",
    "git push --force-with-lease --no-force-with-lease",
    "git push --mirror --no-mirror",
    "git push --repo +not-a-refspec",
    "git push --push-option=--force",
    "git restore --staged .",
    "git restore file",
    "git checkout -b branch",
    "git checkout -b .",
    "git stash drop",
    "git worktree remove path",
    "rsync --delete -n src/ dest/",
    "rsync --exclude --delete src/ dest/",
    "rsync --filter=--delete src/ dest/",
    "echo 'rm -rf build'",
    "echo hi # rm -rf build",
    "echo hi > 'rm -rf build'",
    "time -o 'rm -rf build' echo ok",
    "sudo -u rm echo -rf build",
    "env A='rm -rf build' echo ok",
  ]) {
    it(`does not invent a destructive effect: ${command}`, () => {
      expectStatus(command, "posix", "notMatched");
    });
  }

  for (const [dangerous, exempt, rule] of [
    ["git clean -fd -e --dry-run", "git clean -fd --dry-run", "git-clean-force"],
    ["git clean -nfd --no-dry-run", "git clean -fd --no-dry-run -n", "git-clean-force"],
    ["git push -f --push-option --dry-run", "git push -f --dry-run", "git-push-force"],
    ["git push -nf --no-dry-run", "git push -f --no-dry-run -n", "git-push-force"],
    ["git push --mirror --no-force", "git push --mirror --no-mirror", "git-push-force"],
    ["rsync --delete --exclude --help src/ dest/", "rsync --delete --help", "rsync-delete"],
    [
      "rsync --delete --filter --dry-run src/ dest/",
      "rsync --delete -n src/ dest/",
      "rsync-delete",
    ],
  ] as const) {
    it(`keeps exemption words distinct from values/cancellation: ${dangerous}`, () => {
      expectMatched(dangerous, "posix", `safety.bash.${rule}`);
      assert.deepStrictEqual(matchDangerousCommand(exempt, "posix"), { status: "notMatched" });
    });
  }

  for (const command of [
    "bash -c 'rm -rf build'",
    "powershell -Command 'rm -rf build'",
    "eval 'rm -rf build'",
    "$exe -rf build",
    "git -c alias.wipe='reset --hard' wipe",
    "env -S 'rm -rf build'",
    "time --unknown rm -rf build",
    "for x in a; do rm -rf build; done",
    "rm 'unterminated",
    "x".repeat(10_001),
  ]) {
    it(`labels unsupported boundaries: ${command.slice(0, 60)}`, () => {
      expectStatus(command, "posix", "unsupported");
    });
  }

  // 2026-09-17 review：已识别的危险选项不因同一命令内出现未知选项而失效（存在性规则）。
  for (const [command, rule] of [
    ["rm -rfx build", "remove-critical-path"],
    ["rm -rfP build", "remove-critical-path"],
    ["rm -rf -W build", "remove-critical-path"],
    ["rm -rf --preserve-root=all build", "remove-critical-path"],
    ["rm -rf --totally-unknown build", "remove-critical-path"],
    ["rsync -a --delete --info=progress2 src/ dest/", "rsync-delete"],
    ["rsync -a --delete --stats src/ dest/", "rsync-delete"],
    ["rsync -ai --delete src/ dest/", "rsync-delete"],
    ["rsync -a --delete --partial-dir=.rsync-partial src/ dest/", "rsync-delete"],
    ["rsync --unknown-flag --delete src/ dest/", "rsync-delete"],
    ["git push --force --no-verify origin main", "git-push-force"],
    ["git push --force --no-recurse-submodules origin main", "git-push-force"],
    ["git push --force --totally-unknown origin main", "git-push-force"],
    ["git -c core.pager=cat reset --hard HEAD~1", "git-reset-hard"],
    ["git -p reset --hard", "git-reset-hard"],
    ["git --exec-path=/opt/git reset --hard", "git-reset-hard"],
    ["git reset --hard --totally-unknown", "git-reset-hard"],
    ["git checkout -f -t origin/main", "git-discard-tree"],
    ["git checkout -f --guess main", "git-discard-tree"],
    ["git stash clear --totally-unknown", "git-stash-clear"],
    ["git worktree remove --force --totally-unknown path", "git-worktree-force-remove"],
  ] as const) {
    it(`keeps recognized dangerous options when an unknown option appears: ${command}`, () => {
      expectMatched(command, "posix", `safety.bash.${rule}`);
    });
  }

  for (const command of [
    "rm --totally-unknown build",
    "rsync --unknown-flag src/ dest/",
    "git push --totally-unknown origin main",
    "git reset --totally-unknown",
  ]) {
    it(`still reports unsupported when unknown options leave no reliable hit: ${command}`, () => {
      expectStatus(command, "posix", "unsupported");
    });
  }

  it("unknown options in interspersed scans do not consume the next word or enter flags", () => {
    const words = analyzeBashCommand("rm --unknown -rf target").commands[0]!.words.slice(1);
    const parsed = parseOptions(words, optionTable("-r -f"), {
      ordering: "interspersed",
      unknown: "continue",
    });
    assert.equal(parsed.unsupported, true);
    assert.deepStrictEqual(parsed.flags, ["-r", "-f"]);
    assert.deepStrictEqual(
      parsed.operands.map((word) => word.value),
      ["target"],
    );
  });

  for (const command of [
    "git reset --hard 2>nul",
    "git reset --hard > out.txt",
    "git reset --hard >> out.txt",
    "git push --force origin main 2>nul",
    "rm -rf build 2>nul",
    "rm -rf build 2> nul",
  ]) {
    it(`CMD trailing redirection target keeps the command matched: ${command}`, () => {
      expectStatus(command, "cmd", "matched");
    });
  }
  for (const command of ["git reset --hard >", "git reset --hard 2>", "git reset --hard > "]) {
    it(`CMD redirection without a target stays unsupported: ${command}`, () => {
      expectStatus(command, "cmd", "unsupported");
    });
  }

  for (const command of [
    "rm -rf build",
    '"C:\\tools\\git.exe" reset --hard',
    "echo ok & git stash clear",
    "git clean -fd && echo ok",
  ]) {
    it(`CMD: ${command}`, () => {
      expectStatus(command, "cmd", "matched");
    });
  }
  for (const redirection of [">rem", "> rem", "2>rem", ">>rem", "<rem", '>"rem"']) {
    it(`CMD redirection target is not a REM comment: ${redirection}`, () => {
      expectMatched(`${redirection} git reset --hard`, "cmd", "safety.bash.git-reset-hard");
    });
  }
  for (const command of [
    "rem git reset --hard",
    ">rem rem git reset --hard",
    ">rem rem ignored & git reset --hard",
  ]) {
    it(`CMD preserves actual REM comments: ${command}`, () => {
      assert.deepStrictEqual(matchDangerousCommand(command, "cmd"), { status: "notMatched" });
    });
  }
  for (const command of [
    "rem rm -rf build",
    ":: rm -rf build",
    'echo "rm -rf build"',
    "'rm' -rf build",
    "git reset '--hard'",
    "(echo hi & (rm -rf build))",
  ]) {
    it(`CMD quotes/comments: ${command}`, () => {
      expectNotMatched(command, "cmd");
    });
  }
  it("does not apply Bash grammar to legacy or unsupported shells", () => {
    expectStatus("rm -rf build", "legacy-shell", "unsupported");
  });

  for (const dialect of ["posix", "git-bash", "cmd"] as const) {
    it(`${dialect} keeps rm recursive + force independent of help position and wrappers`, () => {
      for (const flags of ["-rf", "-f -R", "--recursive --force"]) {
        for (const query of ["--help", "--version"]) {
          for (const args of [
            `${flags} target ${query}`,
            `${query} ${flags} target`,
            `${flags} ${query}`,
            `${flags} -- ${query}`,
          ]) {
            for (const wrapper of ["", "env A=b ", "time -o timing.txt ", "sudo -u root "]) {
              const command = `${wrapper}rm ${args}`;
              expectMatched(command, dialect, "safety.bash.remove-critical-path");
            }
          }
        }
      }
      for (const command of ["rm --help", "rm -- -rf"]) {
        assert.deepStrictEqual(
          matchDangerousCommand(command, dialect),
          { status: "notMatched" },
          command,
        );
      }
    });
  }

  it("makes operand scanning a caller-owned policy instead of a shared default", () => {
    const words = analyzeBashCommand("rm -rf target --help").commands[0]!.words.slice(1);
    const table = optionTable("-r -f --help");
    const stopped = parseOptions(words, table, {
      ordering: "stop-at-operand",
      unknown: "abort",
    });
    assert.deepStrictEqual(stopped.flags, ["-r", "-f"]);
    assert.deepStrictEqual(
      stopped.operands.map((word) => word.value),
      ["target", "--help"],
    );
    const interspersed = parseOptions(words, table, {
      ordering: "interspersed",
      unknown: "continue",
    });
    assert.deepStrictEqual(interspersed.flags, ["-r", "-f", "--help"]);
    assert.deepStrictEqual(
      interspersed.operands.map((word) => word.value),
      ["target"],
    );
  });

  it("abort policy stops at the first unknown option so wrappers cannot locate the real command", () => {
    const words = analyzeBashCommand("time --unknown rm -rf target").commands[0]!.words.slice(1);
    const parsed = parseOptions(words, optionTable("-p"), {
      ordering: "stop-at-operand",
      unknown: "abort",
    });
    assert.equal(parsed.unsupported, true);
    assert.deepStrictEqual(parsed.flags, []);
  });

  it(
    "native macOS rm treats trailing help/version as deletion operands in an isolated directory",
    { skip: process.platform !== "darwin" },
    async () => {
      // 独立 oracle：不调用 matcher 来决定真实程序应如何解析；所有删除目标都由本测试创建。
      const directory = await mkdtemp(join(tmpdir(), "zcode-guarded-rm-oracle-"));
      try {
        await mkdir(join(directory, "target"));
        await writeFile(join(directory, "target", "keep.txt"), "case-owned");
        await writeFile(join(directory, "--help"), "case-owned");
        await writeFile(join(directory, "--version"), "case-owned");
        await promisify(execFile)("/bin/rm", ["-rf", "target", "--help", "--version"], {
          cwd: directory,
          timeout: 5000,
        });
        for (const operand of ["target", "--help", "--version"]) {
          await assert.rejects(access(join(directory, operand)), { code: "ENOENT" });
        }
        expectStatus("rm -rf target --help --version", "posix", "matched");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("Guarded deletion catalog", () => {
  for (const command of [
    "rm first --help",
    "rm first --version",
    "rm first -f",
    "rm first --",
  ]) {
    it(`counts BSD rm trailing option-shaped filenames: ${command}`, () => {
      expectMatched(command, "posix", "safety.bash.remove-critical-path");
    });
  }

  for (const dialect of ["posix", "git-bash"] as const) {
    it(`${dialect} recursive and syntactically batch rm`, () => {
      for (const command of [
        "rm -r dir",
        "rm -R dir",
        "rm --recursive dir",
        "rm -ri dir",
        "rm -r --help",
        "rm a b",
        'rm "one file" "two files"',
        "rm -- -r -f",
        "rm *.log",
        "rm file?.txt",
        "rm [ab].txt",
        'rm "prefix"*.log',
        "rm -f *.log",
        "rm -r --unknown dir",
        "env A=b rm -r dir",
        "time -o timing.txt rm a b",
        "sudo -u root rm *.log",
        "echo ready; rm a b",
        "true && rm -r dir",
        "false || rm *.log",
        "rm a b | cat",
        "rm a b > output",
        "rm a b # keep comment",
      ]) {
        expectMatched(command, dialect, "safety.bash.remove-critical-path");
      }
      for (const command of [
        "rm one",
        "rm -f one",
        'rm "one file"',
        "rm -- -r",
        "rm --help",
        'rm "*.log"',
        "rm '*.log'",
        "rm \\*.log",
        "rm file\\?.txt",
        "rm \\[ab].txt",
        "rm $TARGET",
        'rm "$TARGET"',
        "rm {a,b}",
        "rm $(echo target)",
        "rm $(echo *)",
        "rm ${TARGET:-*}",
        'echo "rm a b"',
        "echo ok # rm a b",
        "echo ok > rm",
        "rmdir empty",
        "rmdir /s folder",
        "del file",
        "xargs rm -r",
        "npx rimraf dir",
        "sh -c 'rm -r dir'",
      ]) {
        expectNotMatched(command, dialect);
      }
    });
  }

  for (const flags of ["-d", "-x", "-d -x"]) {
    it(`BSD find ${flags} keeps the starting-path phase`, () => {
      for (const command of [
        `find ${flags} . -type f -delete`,
        `find ${flags} "space dir" another -delete`,
        `time -o timing.txt find ${flags} . -delete`,
      ]) {
        expectMatched(command, "posix", "safety.bash.find-delete");
      }
      for (const command of [
        `find ${flags} . -type f -print`,
        `find ${flags} . -name '-delete'`,
        `find ${flags} . -exec echo -delete \\;`,
      ]) {
        assert.deepStrictEqual(
          matchDangerousCommand(command, "posix"),
          { status: "notMatched" },
          command,
        );
      }
      assert.deepStrictEqual(matchDangerousCommand(`find ${flags} . -unknown -delete`, "posix"), {
        status: "unsupported",
      });
    });
  }

  for (const dialect of ["posix", "git-bash"] as const) {
    it(`${dialect} find action arity`, () => {
      for (const command of [
        "find . -delete",
        "find . -type f -name '*.log' -delete",
        "find . \\( -name a -o -name b \\) -delete",
        "find . -false -a -delete",
        "find . -exec echo {} \\; -delete",
        "find . -execdir echo {} + -delete",
        "find . -ok echo {} \\; -delete",
        "find . -okdir echo {} \\; -delete",
        "find -L . -maxdepth 2 -mtime +1 -delete",
        "find . -delete -unknown value",
        "time -o file find . -delete",
        "find . -unknown value; rm -r dir",
      ]) {
        assert.equal(matchDangerousCommand(command, dialect).status, "matched", command);
      }
      for (const command of [
        "find . -name '-delete'",
        "find . -path -delete",
        "find . -printf '-delete'",
        "find . -fprintf out '-delete'",
        "find . -fprint -delete",
        "find . -exec echo -delete \\;",
        "find . -exec rm -rf {} +",
        "find . -okdir echo -delete \\;",
        "find . -print",
        "find . -name '*.log'",
      ]) {
        expectNotMatched(command, dialect);
      }
      for (const command of [
        "find . -unknown -delete",
        "find . -name",
        "find . -exec echo -delete",
      ]) {
        assert.deepStrictEqual(matchDangerousCommand(command, dialect), { status: "unsupported" });
      }
    });
  }

  for (const [command, rule] of [
    ["rd /s folder", "cmd-remove-tree"],
    ['RMDIR /S /Q "space dir"', "cmd-remove-tree"],
    ["rmdir folder /s", "cmd-remove-tree"],
    ["rd /s folder /?", "cmd-remove-tree"],
    ["rd /s/q folder", "cmd-remove-tree"],
    ["rmdir /Q/S folder", "cmd-remove-tree"],
    ["rd target/s/q", "cmd-remove-tree"],
    ["rd/s/q target", "cmd-remove-tree"],
    ['RMDIR/Q/S "space dir"', "cmd-remove-tree"],
    ["rd target^/s/q", "cmd-remove-tree"],
    ["del/q target\\one.txt", "cmd-delete-files"],
    ["erase/P file", "cmd-delete-files"],
    [">rem rd/s/q target 2>nul", "cmd-remove-tree"],
    ["echo ready && rd target/s/q | more", "cmd-remove-tree"],
    ["del file", "cmd-delete-files"],
    ['ERASE /P "space dir"', "cmd-delete-files"],
    ["del /s /q *.txt", "cmd-delete-files"],
    ["erase dir /A:-R", "cmd-delete-files"],
    ["del file /?", "cmd-delete-files"],
    [">rem rd /s dir", "cmd-remove-tree"],
    ["echo ready & del file", "cmd-delete-files"],
    ["echo ready && rd /s dir", "cmd-remove-tree"],
    ["del file 2>nul", "cmd-delete-files"],
    ["rd /s dir | more", "cmd-remove-tree"],
  ] as const) {
    it(`CMD deletion: ${command}`, () => {
      expectMatched(command, "cmd", `safety.bash.${rule}`);
    });
  }
  for (const command of [
    "rd dir",
    "rmdir /?",
    "rd /?",
    "del",
    "del /q /s",
    "del /?",
    "erase /?",
    "rem del file",
    'echo "rd /s dir"',
    "find file -delete",
    'rd "target/s/q"',
    "rd target > output/s/q",
    "rd/?",
    "del/q",
    "del/?",
    "echo rd/s/q target",
    "rem rd/s/q target",
  ]) {
    it(`CMD non-deletion: ${command}`, () => {
      expectNotMatched(command, "cmd");
    });
  }

  it("keeps CMD builtin switch splitting local and source positions exact", () => {
    const command = "echo ready & rd/s/q target";
    assert.partialDeepStrictEqual(matchDangerousCommand(command, "cmd"), {
      start: command.indexOf("rd/"),
      end: command.length,
    });
    for (const source of ["echo target/s/q", "C:/bin/tool.exe target/s/q", "git -C /s status"]) {
      assert.deepStrictEqual(
        analyzeCmdCommand(source).commands[0]?.map((word) => word.value),
        source.split(" "),
      );
    }
    assert.deepStrictEqual(analyzeCmdCommand('rd "target/s/q"').commands[0]?.map((w) => w.value), [
      "rd",
      "target/s/q",
    ]);
  });

  it("recognizes Git Bash Robocopy drive paths without weakening switch arity", () => {
    for (const command of [
      "robocopy /c/src /c/dst /MIR",
      "env MSYS2_ARG_CONV_EXCL=/MIR robocopy /c/src /c/dst /MIR",
      'robocopy "/c/space src" "/d/space dst" /PURGE',
      "robocopy /MIR /c/src /d/dst /R:0 /W:0",
    ]) {
      expectMatched(command, "git-bash", "safety.bash.robocopy-delete");
    }
    for (const command of [
      "robocopy /c/src /c/dst /MIR /L",
      "robocopy /c/src /c/dst /PURGE /XD /c/excluded /L",
      "robocopy /c/src /c/dst /LOG:/MIR",
      "robocopy /c/src /MIR",
    ]) {
      expectNotMatched(command, "git-bash");
    }
    assert.deepStrictEqual(
      matchDangerousCommand("robocopy /unknown /c/src /c/dst /MIR", "git-bash"),
      { status: "unsupported" },
    );
    assert.deepStrictEqual(
      matchDangerousCommand("robocopy /JOB:job /c/src /c/dst /MIR", "git-bash"),
      { status: "unsupported" },
    );
    expectStatus("robocopy /c/src /c/dst /MIR", "cmd", "unsupported");
  });

  for (const dialect of ["cmd", "git-bash"] as const) {
    it(`${dialect} Robocopy option ownership`, () => {
      for (const command of [
        "robocopy src dst /MIR",
        "robocopy /MIR src dst",
        "robocopy src /PURGE dst",
        "ROBOCOPY.EXE src dst /purge",
        'robocopy "space src" "space dst" /E /PURGE',
        "robocopy src dst /MIR /LOG:out",
        "robocopy src dst /MIR /unknown /L",
        "robocopy src dst /MIR /JOB:job",
        "robocopy src dst /XF /MIR",
      ]) {
        expectMatched(command, dialect, "safety.bash.robocopy-delete");
      }
      for (const command of [
        "robocopy src dst /E",
        "robocopy src dst /MIR /L",
        "robocopy src dst /l /PURGE",
        "robocopy src dst /LOG:/MIR",
        "robocopy src dst /MIR /XF /L",
        "robocopy src dst /MIR /XD /L",
        "robocopy /MIR dst",
        "robocopy src /PURGE",
        "robocopy /?",
        "robocopy src dst /JOB:job",
      ]) {
        expectNotMatched(command, dialect);
      }
      expectStatus("robocopy src dst /unknown /L /MIR", dialect, "unsupported");
    });
  }
  it("does not treat POSIX slash paths as Windows switches", () => {
    expectStatus("robocopy src dst /MIR", "posix", "notMatched");
    expectStatus("rm /s", "posix", "notMatched");
  });

  for (const dialect of ["posix", "git-bash", "cmd"] as const) {
    it(`${dialect} Git clean effective force`, () => {
      for (const command of [
        "git clean -f",
        "git clean -fx",
        "git clean -fX",
        "git clean --force",
        "git clean -nf --no-dry-run",
        "git clean -f -e --dry-run",
      ]) {
        expectMatched(command, dialect, "safety.bash.git-clean-force");
      }
      for (const command of [
        "git clean",
        "git clean -fn",
        "git clean -f --dry-run",
        "git clean -f --help",
        "git clean -n --no-dry-run -f -n",
      ]) {
        expectNotMatched(command, dialect);
      }
    });
  }

  it("keeps literal, dynamic and unquoted glob as separate word facts", () => {
    for (const [source, dynamic, hasUnquotedGlob] of [
      ["*.log", true, true],
      ['"*.log"', false, false],
      ["\\*.log", false, false],
      ["$TARGET", true, false],
      ["{a,b}", true, false],
      ["file?.txt", true, true],
    ] as const) {
      assert.partialDeepStrictEqual(literalPosixWord(source, 3, 3 + source.length), {
        dynamic,
        hasUnquotedGlob,
        start: 3,
        end: 3 + source.length,
      });
    }
  });
});
