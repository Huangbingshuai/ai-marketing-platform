import ts from 'typescript';

export const compactSource = (source: string): string => source.replace(/\s+/gu, ' ').trim();
const script = (source: string) => {
  const text = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/u)?.[1];
  if (!text) throw new Error('Vue script block not found');
  return ts.createSourceFile('component.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
};
/** Read syntax boundaries, not comments or whichever statement happens to follow today. */
export function vueScriptDeclaration(source: string, name: string): string {
  const file = script(source);
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
      return statement.getText(file);
    if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find(
        (item) => ts.isIdentifier(item.name) && item.name.text === name,
      );
      if (declaration) return `const ${declaration.getText(file)};`;
    }
  }
  throw new Error(`Declaration not found: ${name}`);
}
export function vueLifecycleCallback(source: string, name: string): string {
  const file = script(source);
  for (const statement of file.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      ts.isIdentifier(statement.expression.expression) &&
      statement.expression.expression.text === name
    ) {
      const callback = statement.expression.arguments[0];
      if (callback) return callback.getText(file);
    }
  }
  throw new Error(`Lifecycle callback not found: ${name}`);
}
export function executeVueDeclarations(
  source: string,
  names: string[],
  context: Record<string, unknown>,
) {
  const js = ts.transpileModule(
    names.map((name) => vueScriptDeclaration(source, name)).join('\n'),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  return new Function('state', `with (state) { ${js}; return { ${names.join(',')} }; }`)(context);
}
