import type { Command } from "commander";

/**
 * Shell completion generated from the registered Commander commands each
 * time it runs, so it never falls behind the CLI: subcommands, options, and
 * the fixed choices of options and arguments (platforms, certificate types).
 * Live values such as app ids would need API calls from the shell, so they
 * are left out; an option without choices completes file names.
 */

export const SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

interface OptionSpec {
  long?: string;
  short?: string;
  takesValue: boolean;
  choices: string[];
  description: string;
}

interface CommandSpec {
  /** Subcommand names from the program, space-separated; "" for the program itself. */
  path: string;
  subcommands: { name: string; description: string }[];
  options: OptionSpec[];
  /** Fixed choices of the command's positional arguments. */
  argumentChoices: string[];
}

/** The first sentence or clause, short enough for a completion menu. */
function summary(text: string): string {
  const first = (text.split(/(?<=\.)\s|:\s/)[0] ?? "").replace(/\.$/, "");
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

function optionSpecs(command: Command): OptionSpec[] {
  return command.options
    .filter((option) => !option.hidden)
    .map((option) => ({
      long: option.long,
      short: option.short,
      takesValue: option.required || option.optional,
      choices: [...(option.argChoices ?? [])],
      description: summary(option.description),
    }));
}

const HELP: OptionSpec = {
  long: "--help",
  short: "-h",
  takesValue: false,
  choices: [],
  description: "display help for command",
};

/** Every command, with the program's own options offered at every level, as Commander accepts them there. */
function describe(program: Command): CommandSpec[] {
  const global = optionSpecs(program).filter(
    (option) => option.long !== "--version",
  );
  const specs: CommandSpec[] = [];
  const walk = (command: Command, path: string[]) => {
    specs.push({
      path: path.join(" "),
      subcommands: command.commands.map((sub) => ({
        name: sub.name(),
        description: summary(sub.description()),
      })),
      options: [
        ...optionSpecs(command),
        ...(command === program ? [] : global),
        HELP,
      ],
      argumentChoices: command.registeredArguments.flatMap((argument) => [
        ...(argument.argChoices ?? []),
      ]),
    });
    for (const sub of command.commands) walk(sub, [...path, sub.name()]);
  };
  walk(program, []);
  return specs;
}

/** A single-quoted shell word; the same quoting works in bash, zsh and fish. */
function quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function flags(option: OptionSpec): string[] {
  return [option.long, option.short].filter((flag) => flag !== undefined);
}

/** A `case` over command paths (or other keys) that echoes one list per key. */
function caseFunction(
  name: string,
  entries: [key: string, words: string[]][],
  close = ";;",
): string {
  const arms = entries
    .filter(([, words]) => words.length > 0)
    .map(
      ([key, words]) =>
        `    ${quote(key)}) echo ${quote(words.join(" "))} ${close}`,
    );
  return `${name}() {\n  case "$1" in\n${arms.join("\n")}\n  esac\n}`;
}

/** The data functions bash and zsh share: plain words per command path. */
function posixData(name: string, specs: CommandSpec[]): string {
  return [
    caseFunction(
      `_${name}_subcommands`,
      specs.map((spec) => [spec.path, spec.subcommands.map((sub) => sub.name)]),
    ),
    caseFunction(
      `_${name}_options`,
      specs.map((spec) => [spec.path, spec.options.flatMap(flags)]),
    ),
    caseFunction(
      `_${name}_value_options`,
      specs.map((spec) => [
        spec.path,
        spec.options.filter((option) => option.takesValue).flatMap(flags),
      ]),
    ),
    caseFunction(
      `_${name}_choices`,
      specs.flatMap((spec) =>
        spec.options.flatMap((option) =>
          flags(option).map(
            (flag) =>
              [`${spec.path}|${flag}`, option.choices] as [string, string[]],
          ),
        ),
      ),
    ),
    caseFunction(
      `_${name}_arguments`,
      specs.map((spec) => [spec.path, spec.argumentChoices]),
    ),
  ].join("\n\n");
}

/** Walks the words before the cursor into the command path they name. */
function posixWalk(name: string, first: number): string {
  return `  local cmdpath="" word i
  for ((i = ${first}; i < cword; i++)); do
    word="\${words[i]}"
    if [[ " $(_${name}_subcommands "$cmdpath") " == *" $word "* ]]; then
      cmdpath="\${cmdpath:+$cmdpath }$word"
    fi
  done`;
}

function bash(name: string, specs: CommandSpec[]): string {
  return `# ${name} completion for bash, generated from the installed CLI.
# Load it with: source <(${name} completion bash)

${posixData(name, specs)}

_${name}() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local cword=$COMP_CWORD
  local -a words=("\${COMP_WORDS[@]}")
  COMPREPLY=()
${posixWalk(name, 1)}
  if [[ " $(_${name}_value_options "$cmdpath") " == *" $prev "* ]]; then
    local choices
    choices="$(_${name}_choices "$cmdpath|$prev")"
    if [[ -n "$choices" ]]; then
      COMPREPLY=($(compgen -W "$choices" -- "$cur"))
    else
      COMPREPLY=($(compgen -f -- "$cur"))
    fi
    return
  fi
  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "$(_${name}_options "$cmdpath")" -- "$cur"))
    return
  fi
  COMPREPLY=($(compgen -W "$(_${name}_subcommands "$cmdpath") $(_${name}_arguments "$cmdpath")" -- "$cur"))
}

complete -o default -F _${name} ${name}
`;
}

function zsh(name: string, specs: CommandSpec[]): string {
  const described = (
    entries: [string, { word: string; description: string }[]][],
  ) =>
    entries
      .filter(([, items]) => items.length > 0)
      .map(
        ([key, items]) =>
          `    ${quote(key)}) reply=(${items.map(({ word, description }) => quote(`${word.replaceAll(":", "\\:")}:${description}`)).join(" ")}) ;;`,
      )
      .join("\n");
  return `#compdef ${name}
# ${name} completion for zsh, generated from the installed CLI.
# Load it with: source <(${name} completion zsh), after compinit.

${posixData(name, specs)}

_${name}_described_subcommands() {
  reply=()
  case "$1" in
${described(specs.map((spec) => [spec.path, spec.subcommands.map((sub) => ({ word: sub.name, description: sub.description }))]))}
  esac
}

_${name}_described_options() {
  reply=()
  case "$1" in
${described(specs.map((spec) => [spec.path, spec.options.flatMap((option) => flags(option).map((word) => ({ word, description: option.description })))]))}
  esac
}

_${name}() {
  local cur="\${words[CURRENT]}" prev="\${words[CURRENT-1]}" cword=$CURRENT
  local -a reply
${posixWalk(name, 2)}
  if [[ " $(_${name}_value_options "$cmdpath") " == *" $prev "* ]]; then
    local choices="$(_${name}_choices "$cmdpath|$prev")"
    if [[ -n "$choices" ]]; then
      compadd -- \${=choices}
    else
      _files
    fi
    return
  fi
  if [[ "$cur" == -* ]]; then
    _${name}_described_options "$cmdpath"
    _describe -t options option reply
    return
  fi
  local arguments="$(_${name}_arguments "$cmdpath")"
  _${name}_described_subcommands "$cmdpath"
  if (( \${#reply} )); then
    _describe -t commands command reply
  fi
  if [[ -n "$arguments" ]]; then
    compadd -- \${=arguments}
  elif (( ! \${#reply} )); then
    _files
  fi
}

if [[ "$funcstack[1]" == "_${name}" ]]; then
  _${name} "$@"
else
  compdef _${name} ${name}
fi
`;
}

function fish(name: string, specs: CommandSpec[]): string {
  const lines: string[] = [];
  const at = (path: string) => `-n ${quote(`__${name}_at ${quote(path)}`)}`;
  for (const spec of specs) {
    for (const sub of spec.subcommands) {
      lines.push(
        `complete -c ${name} ${at(spec.path)} -a ${quote(sub.name)} -d ${quote(sub.description)}`,
      );
    }
    if (spec.argumentChoices.length > 0) {
      lines.push(
        `complete -c ${name} ${at(spec.path)} -a ${quote(spec.argumentChoices.join(" "))}`,
      );
    } else if (spec.subcommands.length === 0) {
      // A command without subcommands or fixed arguments takes ids or files.
      lines.push(`complete -c ${name} ${at(spec.path)} -F`);
    }
    for (const option of spec.options) {
      const parts = [`complete -c ${name}`, at(spec.path)];
      if (option.long) parts.push(`-l ${quote(option.long.slice(2))}`);
      if (option.short) parts.push(`-s ${quote(option.short.slice(1))}`);
      if (option.choices.length > 0) {
        parts.push(`-x -a ${quote(option.choices.join(" "))}`);
      } else if (option.takesValue) {
        parts.push("-r -F");
      }
      parts.push(`-d ${quote(option.description)}`);
      lines.push(parts.join(" "));
    }
  }
  const subcommands = specs
    .filter((spec) => spec.subcommands.length > 0)
    .map(
      (spec) =>
        `    case ${quote(spec.path)}\n        printf '%s\\n' ${spec.subcommands.map((sub) => quote(sub.name)).join(" ")}`,
    )
    .join("\n");
  return `# ${name} completion for fish, generated from the installed CLI.
# Load it with: ${name} completion fish | source

function __${name}_subcommands
    switch "$argv[1]"
${subcommands}
    end
end

function __${name}_path
    set -l cmdpath ''
    for word in (commandline -opc)[2..-1]
        if contains -- $word (__${name}_subcommands "$cmdpath")
            set cmdpath (string trim -- "$cmdpath $word")
        end
    end
    echo "$cmdpath"
end

function __${name}_at
    set -l current (__${name}_path)
    test "$current" = "$argv[1]"
end

complete -c ${name} -f
${lines.join("\n")}
`;
}

/** The completion script for one shell, from the program as it is registered now. */
export function completionScript(program: Command, shell: Shell): string {
  const specs = describe(program);
  const name = program.name();
  if (shell === "bash") return bash(name, specs);
  if (shell === "zsh") return zsh(name, specs);
  return fish(name, specs);
}
