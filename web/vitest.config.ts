import { defineConfig } from "vitest/config";

/**
 * Testes de render do frontend: o painel é servido pelo próprio backend, então
 * uma página que "compila" mas quebra em tempo de execução só aparece como tela
 * branca no navegador. Aqui os componentes são montados de verdade no jsdom
 * para pegar exatamente esse tipo de falha (ordem de hooks, props inexistentes,
 * dados da API com formato diferente do esperado).
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.tsx"],
    restoreMocks: true,
  },
});
