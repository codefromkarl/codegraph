import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const gdscriptExtractor: LanguageExtractor = {
  functionTypes: ['function_definition', 'constructor_definition', 'lambda'],
  classTypes: ['class_definition'],
  methodTypes: ['function_definition', 'constructor_definition'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: ['enum_definition'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: [],
  importTypes: ['extends_statement'],
  callTypes: ['call', 'attribute_call', 'base_call'],
  variableTypes: [
    'variable_statement',
    'export_variable_statement',
    'onready_variable_statement',
    'const_statement',
  ],
  fieldTypes: [
    'variable_statement',
    'export_variable_statement',
    'onready_variable_statement',
  ],
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
  resolveName: (node, _source) => {
    // constructor_definition: func _init() → the name is the '_init' token at child[1]
    if (node.type === 'constructor_definition') {
      return '_init';
    }
    return undefined;
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'static_keyword') return true;
    }
    return false;
  },
  isConst: (node) => {
    return node.type === 'const_statement';
  },
  extractImport: (node, source) => {
    if (node.type === 'extends_statement') {
      // extends Node → class name
      // extends "res://enemies/goblin.gd" → string path
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child?.isNamed) continue;
        const text = getNodeText(child, source);
        if (child.type === 'string') {
          return {
            moduleName: text.replace(/^["']|["']$/g, ''),
            signature: `extends ${text}`,
          };
        }
        if (child.type === 'type') {
          // Extract the identifier inside the type node
          const id = child.child(0);
          const name = id ? getNodeText(id, source) : text;
          return {
            moduleName: name,
            signature: `extends ${name}`,
          };
        }
      }
    }
    return null;
  },
  extractVariables: (node, source) => {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return [];

    const name = getNodeText(nameNode, source);
    // 'type' field covers both explicit (: float) and inferred (:=) types
    const typeNode = getChildByField(node, 'type');
    const sig = typeNode ? getNodeText(typeNode, source) : undefined;

    return [
      {
        name,
        kind: node.type === 'const_statement' ? 'constant' : 'variable',
        signature: sig,
      },
    ];
  },
};
