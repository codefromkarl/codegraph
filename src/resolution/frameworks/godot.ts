/**
 * Godot Framework Resolver
 *
 * Handles GDScript-specific patterns: signals, node paths, preload, and
 * class_name declarations. Bridges dynamic dispatch boundaries that
 * tree-sitter parsing alone cannot resolve statically.
 */

import { Node } from '../../types';
import {
  FrameworkResolver,
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
  FrameworkExtractionResult,
} from '../types';

/**
 * Godot built-in types — referenced but never defined in the project.
 * Returning null from resolve() for these prevents wasted lookup.
 */
const BUILTIN_TYPES = new Set([
  'Node',
  'Node2D',
  'Node3D',
  'Control',
  'CanvasItem',
  'Object',
  'RefCounted',
  'Resource',
  'Sprite2D',
  'Sprite3D',
  'AnimatedSprite2D',
  'CharacterBody2D',
  'CharacterBody3D',
  'RigidBody2D',
  'RigidBody3D',
  'StaticBody2D',
  'StaticBody3D',
  'Area2D',
  'Area3D',
  'Camera2D',
  'Camera3D',
  'CollisionShape2D',
  'CollisionShape3D',
  'CollisionPolygon2D',
  'CollisionPolygon3D',
  'RayCast2D',
  'RayCast3D',
  'Label',
  'RichTextLabel',
  'Button',
  'TextureButton',
  'LineEdit',
  'TextEdit',
  'ProgressBar',
  'HBoxContainer',
  'VBoxContainer',
  'GridContainer',
  'CenterContainer',
  'MarginContainer',
  'Panel',
  'PanelContainer',
  'ColorRect',
  'TextureRect',
  'NinePatchRect',
  'SpriteFrames',
  'AnimationPlayer',
  'AnimationTree',
  'AnimationNodeStateMachine',
  'AudioStreamPlayer',
  'AudioStreamPlayer2D',
  'AudioStreamPlayer3D',
  'TileMap',
  'TileMapLayer',
  'TileSet',
  'Timer',
  'Tween',
  'SceneTree',
  'Viewport',
  'Input',
  'InputMap',
  'Engine',
  'ProjectSettings',
  'ResourceLoader',
  'ResourceSaver',
  'Signal',
  'Callable',
  'String',
  'int',
  'float',
  'bool',
  'Variant',
  'Vector2',
  'Vector2i',
  'Vector3',
  'Vector3i',
  'Vector4',
  'Vector4i',
  'Color',
  'Rect2',
  'Rect2i',
  'Transform2D',
  'Transform3D',
  'AABB',
  'Basis',
  'Quaternion',
  'Projection',
  'PackedScene',
  'PackedByteArray',
  'PackedInt32Array',
  'PackedInt64Array',
  'PackedFloat32Array',
  'PackedFloat64Array',
  'PackedStringArray',
  'PackedVector2Array',
  'PackedVector3Array',
  'PackedColorArray',
  'Array',
  'Dictionary',
  'RID',
  'StringName',
  'NodePath',
  'RandomNumberGenerator',
  'JSON',
  'Time',
  'OS',
  'DisplayServer',
  'RenderingServer',
  'PhysicsServer2D',
  'PhysicsServer3D',
  'AudioServer',
  'Engine',
  'ClassDB',
  'Marshalls',
  'IP',
  'StreamPeer',
  'TCP_Server',
  'PacketPeer',
  'UDPServer',
  'WebSocketPeer',
  'WebSocketServer',
]);

/**
 * Module-level cache: maps node path → script path from .tscn files.
 * Populated lazily on first detect() call.
 */
let tscnNodeCache: Map<string, string> | null = null;

/**
 * Clear the .tscn node cache (for testing).
 */
export function clearTscnCache(): void {
  tscnNodeCache = null;
}

/**
 * Parse all .tscn files in the project and build a node-path → script-path map.
 */
function buildTscnNodeCache(context: ResolutionContext): Map<string, string> {
  if (tscnNodeCache) return tscnNodeCache;

  const cache = new Map<string, string>();
  const allFiles = context.getAllFiles();

  for (const filePath of allFiles) {
    if (!filePath.endsWith('.tscn')) continue;

    const content = context.readFile(filePath);
    if (!content) continue;

    // Parse ext_resource: id → path
    const extRes = new Map<string, string>();
    const er1 = /\[ext_resource\s+[^\]]*?path="([^"]+)"[^\]]*?id="(\d+)"[^\]]*\]/g;
    const er2 = /\[ext_resource\s+[^\]]*?id="(\d+)"[^\]]*?path="([^"]+)"[^\]]*\]/g;
    let m: RegExpExecArray | null;
    while ((m = er1.exec(content)) !== null) extRes.set(m[2]!, m[1]!);
    while ((m = er2.exec(content)) !== null) extRes.set(m[1]!, m[2]!);

    // Parse node blocks: build name→script map relative to this .tscn
    const blocks = content.split(/(?=\[node\s)/);
    const relativePathDir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/') + 1) : '';

    for (const block of blocks) {
      if (!block.startsWith('[node')) continue;
      const nameM = block.match(/name="([^"]+)"/);
      const nodeName = nameM ? nameM[1]! : '';
      if (!nodeName) continue;

      // Build a simple node path (just the leaf name — root is first unnamed node too)
      const scriptM = block.match(/script\s*=\s*ExtResource\("(\d+)"\)/);
      if (scriptM) {
        const scriptPath = extRes.get(scriptM[1]!);
        if (scriptPath && scriptPath.endsWith('.gd')) {
          // Strip res:// prefix to get project-relative path
          const cleanPath = scriptPath.replace(/^res\:\/\//, '');
          cache.set(nodeName, cleanPath);
        }
      }

      const scriptM2 = block.match(/script\s*=\s*Resource\("([^"]+)"\)/);
      if (scriptM2) {
        const scriptPath = scriptM2[1]!;
        if (scriptPath.endsWith('.gd')) {
          cache.set(nodeName, relativePathDir + scriptPath);
        }
      }
    }
  }

  tscnNodeCache = cache;
  return cache;
}

/**
 * Built-in GDScript functions that are not user-defined.
 */
const BUILTIN_FUNCTIONS = new Set([
  'preload',
  'load',
  'print',
  'printerr',
  'printraw',
  'push_error',
  'push_warning',
  'assert',
  'len',
  'abs',
  'sign',
  'floor',
  'ceil',
  'round',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sqrt',
  'fmod',
  'fposmod',
  'posmod',
  'randf',
  'randi',
  'randfn',
  'randf_range',
  'randi_range',
  'seed',
  'rand_seed',
  'deg_to_rad',
  'rad_to_deg',
  'lerp',
  'lerpf',
  'inverse_lerp',
  'remap',
  'clamp',
  'move_toward',
  'nearest_po2',
  'wrapf',
  'wrapi',
  'pow',
  'log',
  'exp',
  'is_nan',
  'is_inf',
  'ease',
  'smoothstep',
  'range',
  'min',
  'max',
  'convert',
  'type_exists',
  'char',
  'str',
  'str_to_var',
  'var_to_str',
  'bytes_to_var',
  'var_to_bytes',
  'hash',
  'Color8',
  'instance_from_id',
  'is_instance_valid',
  'is_same',
  'weakref',
  'typeof',
]);

export const godotResolver: FrameworkResolver = {
  name: 'godot',
  languages: ['gdscript', 'godot_scene'],

  detect(context: ResolutionContext): boolean {
    // Check for Godot project
    if (!context.fileExists('project.godot')) return false;
    // Warm the .tscn node→script cache for resolve()
    buildTscnNodeCache(context);
    return true;
  },

  claimsReference(name: string): boolean {
    // Signal.connect() calls — "connect" is a Godot built-in method
    // on every Signal, but it creates a dynamic binding we want to bridge.
    // 'emit' similarly for signal.emit().
    return name === 'connect' || name === 'emit';
  },

  resolve(
    ref: UnresolvedRef,
    context: ResolutionContext
  ): ResolvedRef | null {
    // ── Attempt 1: Resolve node path ($Name) to a .tscn-bound script ──
    if (ref.referenceKind === 'references' && !ref.referenceName.includes('/')) {
      const cache = tscnNodeCache ?? buildTscnNodeCache(context);
      const scriptPath = cache.get(ref.referenceName);
      if (scriptPath) {
        return {
          original: ref,
          targetNodeId: `file:${scriptPath}`,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    // ── Attempt 2: Resolve signal name from candidates (emit → signal def) ──
    if (ref.candidates && ref.candidates.length > 0) {
      // The candidates are signal IDs like "signal:file.gd:signalName"
      // which we inject in extract() for .emit() calls
      return null; // Let the standard resolution handle these
    }

    // ── Attempt 3: Skip Godot built-in types ──
    if (BUILTIN_TYPES.has(ref.referenceName)) {
      return {
        original: ref,
        targetNodeId: `builtin:${ref.referenceName}`,
        confidence: 0.9,
        resolvedBy: 'framework',
      };
    }

    // ── Attempt 4: Skip built-in functions ──
    if (BUILTIN_FUNCTIONS.has(ref.referenceName)) {
      return {
        original: ref,
        targetNodeId: `builtin:${ref.referenceName}`,
        confidence: 0.9,
        resolvedBy: 'framework',
      };
    }

    return null;
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    // ── .tscn / .tres scene/resource file parsing ──
    if (filePath.endsWith('.tscn') || filePath.endsWith('.tres')) {
      return extractTscn(filePath, content, nodes, references, now);
    }

    if (!filePath.endsWith('.gd')) return { nodes: [], references: [] };

    // ── 1. Signal declarations: signal NAME(param1, param2, ...) ──
    const signalRegex = /^\s*signal\s+(\w+)\s*(?:\(([^)]*)\))?/gm;
    let match: RegExpExecArray | null;
    while ((match = signalRegex.exec(content)) !== null) {
      const signalName = match[1]!;
      const params = match[2] || '';
      const line = content.slice(0, match.index).split('\n').length;
      // Create a synthetic node for the signal so it can be referenced
      const signalNode: Node = {
        id: `signal:${filePath}:${signalName}`,
        kind: 'function',
        name: signalName,
        qualifiedName: `${filePath}::${signalName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'gdscript',
        signature: `signal ${signalName}(${params})`,
        updatedAt: now,
      };
      nodes.push(signalNode);
    }

    // ── 2. Signal connections: X.connect(Y) or X.connect(Callable(Y)) ──
    const connectRegex = /\.connect\s*\(\s*(?:Callable\s*\(\s*)?(\w+)\s*(?:\)\s*)?(?:\s*[,)]|$)/g;
    while ((match = connectRegex.exec(content)) !== null) {
      const handlerName = match[1]!;
      const line = content.slice(0, match.index).split('\n').length;

      // Skip built-in
      if (BUILTIN_FUNCTIONS.has(handlerName) || BUILTIN_TYPES.has(handlerName)) continue;

      references.push({
        fromNodeId: `file:${filePath}`,
        referenceName: handlerName,
        referenceKind: 'references',
        line,
        column: match.index,
        filePath,
        language: 'gdscript',
      });
    }

    // ── 3. Emit calls: signal_name.emit(...) — bridge to signal ──
    const emitRegex = /\.emit\s*\(/g;
    while ((match = emitRegex.exec(content)) !== null) {
      const emitPos = match.index;
      // Walk backwards to find the signal name (receiver)
      const before = content.slice(0, emitPos);
      const identMatch = before.match(/(\w+)\.emit\s*\(/);
      if (identMatch) {
        const signalName = identMatch[1]!;
        const line = content.slice(0, match.index).split('\n').length;
        // Emit is a synthetic calls edge from the containing function to the signal
        references.push({
          fromNodeId: `file:${filePath}`,
          referenceName: signalName,
          referenceKind: 'references',
          line,
          column: emitPos,
          filePath,
          language: 'gdscript',
          candidates: [`${filePath}::${signalName}`],
        });
      }
    }

    // ── 4. class_name declarations: class_name MyClass ──
    const classnameRegex = /^\s*class_name\s+(\w+)/gm;
    while ((match = classnameRegex.exec(content)) !== null) {
      const className = match[1]!;
      const line = content.slice(0, match.index).split('\n').length;

      // Create a module-level alias node so other files can reference it
      const aliasNode: Node = {
        id: `classname:${filePath}:${className}`,
        kind: 'module',
        name: className,
        qualifiedName: `class_name::${className}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'gdscript',
        updatedAt: now,
      };
      nodes.push(aliasNode);
    }

    // ── 5. preload("res://..."): create file-level references ──
    const preloadRegex = /\bpreload\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((match = preloadRegex.exec(content)) !== null) {
      const targetPath = match[1]!;
      const line = content.slice(0, match.index).split('\n').length;

      references.push({
        fromNodeId: `file:${filePath}`,
        referenceName: targetPath,
        referenceKind: 'imports',
        line,
        column: match.index,
        filePath,
        language: 'gdscript',
      });
    }

    // ── 6. @rpc annotations — mark functions as network entry points ──
    const rpcRegex = /^\s*@rpc(?:\s*\(([^)]*)\))?/gm;
    while ((match = rpcRegex.exec(content)) !== null) {
      const rpcMode = match[1] || 'unreliable';
      const line = content.slice(0, match.index).split('\n').length;

      // Look for the next function definition after this annotation
      const after = content.slice(match.index + match[0].length);
      const funcMatch = after.match(/^\s*func\s+(\w+)/m);
      if (funcMatch) {
        const funcName = funcMatch[1]!;
        const funcLine = line + after.slice(0, funcMatch.index).split('\n').length;
        // Create a synthetic reference marking this function as an RPC entry point
        references.push({
          fromNodeId: `file:${filePath}`,
          referenceName: funcName,
          referenceKind: 'references',
          line: funcLine,
          column: match.index,
          filePath,
          language: 'gdscript',
          candidates: [`rpc_mode:${rpcMode}`],
        });
      }
    }

    // ── 7. Group references: add_to_group / call_group / get_nodes_in_group ──
    const groupCallRegex = /(?:get_tree\(\)\.)?(call_group|notification_group)\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/g;
    while ((match = groupCallRegex.exec(content)) !== null) {
      const fnCall = match[1]!;
      const groupName = match[2]!;
      const methodName = match[3]!;
      const line = content.slice(0, match.index).split('\n').length;

      references.push({
        fromNodeId: `file:${filePath}`,
        referenceName: methodName,
        referenceKind: 'references',
        line,
        column: match.index,
        filePath,
        language: 'gdscript',
        candidates: [`group_dispatch:${fnCall}::${groupName}`],
      });
    }

    // add_to_group / remove_from_group — group membership tracking
    const groupMemberRegex = /(?:add_to_group|remove_from_group)\s*\(\s*["']([^"']+)["']/g;
    while ((match = groupMemberRegex.exec(content)) !== null) {
      const groupName = match[1]!;
      const line = content.slice(0, match.index).split('\n').length;

      references.push({
        fromNodeId: `file:${filePath}`,
        referenceName: groupName,
        referenceKind: 'references',
        line,
        column: match.index,
        filePath,
        language: 'gdscript',
        candidates: [`group_membership:${groupName}`],
      });
    }

    // ── 8. $ NodePath references: $Node/Path, $/root/Node ──
    // These create references from the file to the target script
    const nodepathRegex = /\$(\/[^;)\]\n\r]+|[A-Za-z_]\w*(?:\/[A-Za-z_]\w*)*)/g;
    while ((match = nodepathRegex.exec(content)) !== null) {
      const path = match[1]!;
      const line = content.slice(0, match.index).split('\n').length;

      references.push({
        fromNodeId: `file:${filePath}`,
        referenceName: path,
        referenceKind: 'references',
        line,
        column: match.index,
        filePath,
        language: 'gdscript',
      });
    }

    return { nodes, references };
  },
};

/**
 * Parse a Godot .tscn / .tres file and extract resource references, script
 * bindings, and editor-wired signal connections.
 */
function extractTscn(
  filePath: string,
  content: string,
  _nodes: Node[],
  references: UnresolvedRef[],
  _now: number
): FrameworkExtractionResult {
  // Map ext_resource id → path
  const extResources = new Map<string, string>();

  // Two orderings: path="..." id="N" or id="N" path="..."
  const erRegex1 = /\[ext_resource\s+[^\]]*?path="([^"]+)"[^\]]*?id="(\d+)"[^\]]*\]/g;
  const erRegex2 = /\[ext_resource\s+[^\]]*?id="(\d+)"[^\]]*?path="([^"]+)"[^\]]*\]/g;
  let match: RegExpExecArray | null;
  while ((match = erRegex1.exec(content)) !== null) {
    extResources.set(match[2]!, match[1]!);
  }
  while ((match = erRegex2.exec(content)) !== null) {
    extResources.set(match[1]!, match[2]!);
  }

  // Track which node has which script
  const nodeScripts: Array<{ nodeName: string; scriptPath: string; line: number }> = [];
  const instanceScenes: Array<{ scenePath: string; line: number }> = [];

  // Track script bindings from [node] and [resource] blocks
  // Split into [node ...] or [resource ...] blocks
  const nodeBlocks = content.split(/(?=\[(?:node|resource)\s|\[resource\])/);

  for (const block of nodeBlocks) {
    const isNodeBlock = block.startsWith('[node');
    const isResourceBlock = !isNodeBlock && block.startsWith('[resource');
    if (!isNodeBlock && !isResourceBlock) continue;

    const nameM = block.match(/name="([^"]+)"/);
    const instanceM = block.match(/instance\s*=\s*ExtResource\("(\d+)"\)/);
    const nodeName = nameM ? nameM[1]! : '';

    // Instanced child scene
    if (instanceM) {
      const raw = extResources.get(instanceM[1]!);
      if (raw) {
        const scenePath = raw.replace(/^res\:\/\//, '');
        const line = content.slice(0, block.indexOf('[node')).split('\n').length;
        instanceScenes.push({ scenePath, line });
      }
    }

    // script = ExtResource("N")
    const scriptM = block.match(/script\s*=\s*ExtResource\("(\d+)"\)/);
    if (scriptM) {
      let scriptPath = extResources.get(scriptM[1]!);
      if (scriptPath) {
        scriptPath = scriptPath.replace(/^res\:\/\//, '');
        if (scriptPath.endsWith('.gd')) {
          const line = content.slice(0, block.indexOf(scriptM[0])).split('\n').length;
          nodeScripts.push({ nodeName, scriptPath, line });
        }
      }
    }

    // script = Resource("res://...")
    const scriptM2 = block.match(/script\s*=\s*Resource\("([^"]+)"\)/);
    if (scriptM2) {
      let scriptPath = scriptM2[1]!;
      scriptPath = scriptPath.replace(/^res\:\/\//, '');
      if (scriptPath.endsWith('.gd')) {
        const line = content.slice(0, block.indexOf(scriptM2[0])).split('\n').length;
        nodeScripts.push({ nodeName, scriptPath, line });
      }
    }
  }

  // ── Scene → script references ──
  for (const ns of nodeScripts) {
    references.push({
      fromNodeId: `file:${filePath}`,
      referenceName: ns.scriptPath,
      referenceKind: 'imports',
      line: ns.line,
      column: 0,
      filePath,
      language: 'godot_scene',
    });
  }

  // ── Scene → instanced child scene references ──
  for (const inst of instanceScenes) {
    references.push({
      fromNodeId: `file:${filePath}`,
      referenceName: inst.scenePath,
      referenceKind: 'imports',
      line: inst.line,
      column: 0,
      filePath,
      language: 'godot_scene',
    });
  }

  // ── Editor-wired signal connections ──
  const connRegex = /\[connection\s+signal="([^"]+)"\s+from="([^"]+)"\s+to="([^"]+)"\s+method="([^"]+)"/g;
  while ((match = connRegex.exec(content)) !== null) {
    const signalName = match[1]!;
    const fromNode = match[2]!;
    const toNode = match[3]!;
    const methodName = match[4]!;
    const line = content.slice(0, match.index).split('\n').length;

    // Strip res:// prefix for cache lookup
    const cleanPath = filePath.replace(/^res\:\/\//, '');

    // Resolve 'to' node's script for the fromNodeId
    const toScript = nodeScripts.find((ns) => ns.nodeName === toNode);
    const toScriptClean = toScript ? toScript.scriptPath.replace(/^res\:\/\//, '') : '';
    const toRef = toScript ? `file:${toScriptClean}` : `file:${cleanPath}`;

    // Resolve 'from' node's script for the candidates hint
    const fromScript = nodeScripts.find((ns) => ns.nodeName === fromNode);
    const fromScriptClean = fromScript ? fromScript.scriptPath.replace(/^res\:\/\//, '') : '';
    const signalId = fromScript
      ? `signal:${fromScriptClean}:${signalName}`
      : `signal:${cleanPath}:${signalName}`;

    references.push({
      fromNodeId: toRef,
      referenceName: methodName,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: 'gdscript',
      candidates: [signalId],
    });
  }

  return { nodes: [], references };
}


