import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", ".claude/**"] },
  ...tseslint.configs.recommended,
  {
    // 棚卸し skill の計測スクリプトは、対象リポジトリ側の vitest の Node API
    // （版ごとに形が違い、こちらから型を固定できない）を叩くため any を許す。
    files: ["skills/pseudo-tested-audit/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
