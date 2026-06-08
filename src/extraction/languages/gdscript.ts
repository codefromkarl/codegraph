import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const gdscriptExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_definition'],
  methodTypes: ['function_definition'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: ['enum_definition'],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['call', 'attribute_call', 'base_call'],
  variableTypes: ['variable_statement', 'export_variable_statement', 'onready_variable_statement', 'const_statement'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source);
    }
    return sig;
  },
  isStatic: (node) => {
    // Check for static_keyword child in function/variable definitions
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'static_keyword') return true;
    }
    return false;
  },
  isConst: (node) => {
    return node.type === 'const_statement';
  },
  extractVariables: (node, source) => {
    // GDScript variable declarations: variable_statement, export_variable_statement,
    // onready_variable_statement, const_statement
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return [];

    const name = getNodeText(nameNode, source);
    const typeNode = getChildByField(node, 'type') || getChildByField(node, 'inferred_type');
    const sig = typeNode ? getNodeText(typeNode, source) : undefined;

    return [{
      name,
      kind: node.type === 'const_statement' ? 'constant' : 'variable',
      signature: sig,
    }];
  },
};
