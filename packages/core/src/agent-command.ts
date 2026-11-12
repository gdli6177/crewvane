import parseArgsStringToArgv from "string-argv";
import { basename } from "node:path";

export interface AgentCommand {
  executable: string;
  kind?: string;
  args: string[];
}

export function quoteAgentShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderAgentCommand(
  executable: string,
  args: string[] = [],
): string {
  // Keep bare command names unquoted so the interactive pane shell can resolve
  // aliases and functions. Paths and whitespace still become one strict argv.
  const command = /^[A-Za-z0-9_+@.-]+$/.test(executable)
    ? executable
    : quoteAgentShellArgument(executable);
  return [command, ...args.map(quoteAgentShellArgument)].join(" ");
}

export function renderLoginShellAgentCommand(
  shell: string,
  executable: string,
  args: string[] = [],
): string {
  return `${quoteAgentShellArgument(shell)} -ilc ${
    quoteAgentShellArgument(renderAgentCommand(executable, args))
  }`;
}

export function parseAgentCommand(
  command: string,
  kinds: string[],
): AgentCommand {
  if (
    !command.trim() ||
    command.length > 2_000 ||
    /[\x00-\x1f\x7f;&|<>`$]/.test(command)
  )
    throw new Error(
      "请输入单行 Agent 启动命令；不支持 shell 管道、重定向或变量展开",
    );
  let quote = "";
  for (const character of command) {
    if (character === "'" || character === '"') {
      if (!quote) quote = character;
      else if (quote === character) quote = "";
    }
  }
  if (quote) throw new Error("启动命令的引号没有闭合");
  const [executable, ...args] = parseArgsStringToArgv(command.trim());
  if (!executable || executable.startsWith("-"))
    throw new Error("启动命令缺少 CLI 可执行文件");
  if (
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(executable) ||
    executable === "env"
  )
    throw new Error(
      "启动命令不能设置环境变量；请把 CLI 需要的环境配置写入该 CLI 自身的配置文件",
    );
  const name = basename(executable);
  const kind = kinds.includes(name) ? name : undefined;
  return { executable, kind, args };
}
