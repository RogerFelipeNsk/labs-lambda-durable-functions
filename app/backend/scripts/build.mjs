#!/usr/bin/env node
/**
 * Empacota o backend em um unico artefato ZIP usado pelas duas Lambdas
 * (orchestrator.handler e api.handler).
 *
 * Nao usamos bundler de proposito: funcoes durable exigem codigo deterministico
 * e replay estavel entre invocacoes que podem estar separadas por dias. Manter
 * o codigo-fonte legivel dentro do pacote facilita muito depurar um replay no
 * console da AWS, e o SDK durable vai instalado na versao exata do package.json
 * em vez de depender da versao embutida no runtime.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const stage = join(dist, "package");

console.log("> limpando dist/");
rmSync(dist, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

console.log("> copiando src/");
cpSync(join(root, "src"), stage, { recursive: true });

// package.json minimo: o runtime so precisa saber que isto e ESM.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", dependencies: pkg.dependencies }, null, 2),
);

console.log("> instalando dependencias de producao");
if (!existsSync(join(root, "package-lock.json"))) {
  execFileSync("npm", ["install", "--package-lock-only"], { cwd: root, stdio: "inherit" });
}
cpSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: stage, stdio: "inherit" });
rmSync(join(stage, "package-lock.json"), { force: true });

console.log("> gerando dist/backend.zip");
execFileSync("zip", ["-q", "-r", "-X", join(dist, "backend.zip"), "."], { cwd: stage });

const { size } = statSync(join(dist, "backend.zip"));
console.log(`> pronto: dist/backend.zip (${(size / 1024 / 1024).toFixed(1)} MB)`);
