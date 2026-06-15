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
  languages: ['gdscript'],

  detect(context: ResolutionContext): boolean {
    return context.fileExists('project.godot');
  },

  claimsReference(name: string): boolean {
    // Signal.connect() calls — "connect" is a Godot built-in method
    // on every Signal, but it creates a dynamic binding we want to bridge.
    return name === 'connect' || name === 'emit';
  },

  resolve(
    ref: UnresolvedRef,
    _context: ResolutionContext
  ): ResolvedRef | null {
    // Skip Godot built-in types — they never resolve in user code
    if (BUILTIN_TYPES.has(ref.referenceName)) {
      return {
        original: ref,
        targetNodeId: `builtin:${ref.referenceName}`,
        confidence: 0.9,
        resolvedBy: 'framework',
      };
    }

    // Skip built-in functions
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
    if (!filePath.endsWith('.gd')) return { nodes: [], references: [] };

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

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

    // ── 6. $ NodePath references: $Node/Path, $/root/Node ──
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


