import { describe, expect, it } from "vitest";
import {
  commandIssues,
  cpuProblem,
  envIssues,
  imageProblem,
  memoryProblem,
  nameProblem,
  portsIssues,
  pidsProblem,
  translateIssues,
} from "../src/validation.ts";
import { ptBR } from "../src/i18n/pt-BR.ts";
import { en } from "../src/i18n/en.ts";

function t(key: string, vars?: Record<string, string | number>): string {
  const table = key in ptBR ? ptBR : en;
  let text: string = (table as Record<string, string>)[key] ?? key;
  if (vars) text = text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
  return text;
}

describe("validação espelhada do frontend", () => {
  it("detecta os problemas de imagem com o mesmo código do backend", () => {
    expect(imageProblem("node:22-slim")).toBeNull();
    expect(imageProblem("")?.code).toBe("image.empty");
    expect(imageProblem("node 22")?.code).toBe("image.containsSpaces");
    expect(imageProblem("Node@22!!")?.code).toBe("image.invalidFormat");
    expect(imageProblem("x".repeat(201))?.code).toBe("image.tooLong");
    // Aceita os formatos que o docker pull aceita.
    expect(imageProblem("usuario/meubot:latest")).toBeNull();
    expect(imageProblem("registry.exemplo.com:5000/equipe/bot:v1")).toBeNull();
    expect(imageProblem("python:3.12-slim@sha256:" + "a".repeat(64))).toBeNull();
  });

  it("recursos fora da faixa ganham código com parâmetros", () => {
    expect(memoryProblem(8)?.code).toBe("memory.outOfRange");
    expect(cpuProblem(0)?.code).toBe("cpu.outOfRange");
    expect(pidsProblem(8)?.code).toBe("pids.outOfRange");
    expect(memoryProblem(512)).toBeNull();
    expect(cpuProblem(1)).toBeNull();
    expect(pidsProblem(256)).toBeNull();
  });

  it("valida variáveis de ambiente e portas", () => {
    const envCodes = envIssues([
      { key: "1-ruim", value: "x" },
      { key: "APP_SLUG", value: "y" },
      { key: "TOKEN", value: "a" },
      { key: "token", value: "b" },
    ]).map((issue) => issue.code);
    expect(envCodes).toEqual(["env.invalidKey", "env.reservedKey", "env.duplicateKey"]);

    const portCodes = portsIssues(["99999", "abc", "8080:3000", "8080:3000"]).map((issue) => issue.code);
    expect(portCodes).toEqual(["ports.outOfRange", "ports.invalidMapping", "ports.duplicate"]);
    expect(portsIssues(["8080:3000", "9090"])).toEqual([]);
  });

  it("cobra comando de start conforme o runtime", () => {
    expect(commandIssues("custom", "", "")).toEqual([{ code: "startCommand.requiredForCustom", field: "startCommand" }]);
    expect(commandIssues("node", "", "")).toEqual([{ code: "startCommand.missing", field: "startCommand" }]);
    expect(commandIssues("node", "index.js", "")).toEqual([]);
    expect(commandIssues("python", "", "python main.py")).toEqual([]);
  });

  it("traduz os códigos nos dois idiomas com interpolação", () => {
    const issue = imageProblem("node 22")!;
    const pt = translateIssues([issue], t)[0];
    const textEn = translateIssues([issue], (key, vars) => {
      let text: string = (en as Record<string, string>)[key] ?? key;
      if (vars) text = text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
      return text;
    })[0];
    expect(pt).toContain("node 22");
    expect(textEn).toContain("node 22");
    // Toda chave emitida pelos validadores existe nos dois dicionários.
    for (const code of [
      "image.empty",
      "image.containsSpaces",
      "image.tooLong",
      "image.invalidFormat",
      "image.notAllowed",
      "memory.outOfRange",
      "cpu.outOfRange",
      "pids.outOfRange",
      "env.invalidKey",
      "env.reservedKey",
      "env.duplicateKey",
      "ports.invalidMapping",
      "ports.outOfRange",
      "ports.duplicate",
      "startCommand.requiredForCustom",
      "startCommand.missing",
      "name.length",
    ]) {
      expect(`errors.${code}` in ptBR, code).toBe(true);
      expect(`errors.${code}` in en, code).toBe(true);
    }
  });

  it("imagem vazia é o único problema quando o campo vem em branco", () => {
    expect(imageProblem("   ")?.code).toBe("image.empty");
    expect(nameProblem("  ")).toEqual({ code: "name.length", field: "name" });
  });
});
