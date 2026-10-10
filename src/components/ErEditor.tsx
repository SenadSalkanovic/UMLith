import React, { useState, useMemo, useEffect } from 'react';
import type { Graph, ProgramNode, ProgramEdge, Requirement, Project, Source } from '../../shared/model';
import { GraphSchema, createNodeId, validRelationship, emptyGraph } from '../../shared/model';
import {
  Database,
  Plus,
  Trash2,
  Edit3,
  Link2,
  AlertCircle,
  CheckCircle2,
  X,
  Info,
  Key,
  Shield,
  Layers,
  Table,
  List,
  Check,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

export interface EntityField {
  name: string;
  type: string;
  key?: string; // e.g. 'PK', 'PK (composite)', 'UNIQUE', 'UNIQUE (composite)', 'FK', 'RELATION', or ''
  optional?: boolean; // nullability: true -> nullable, false -> non-null
  mappedName?: string; // column mapping, e.g. 'user_id' or '@map("user_id")'
  defaultValue?: string;
  source?: Source;
}

export type CardinalityType =
  | 'one → many'
  | 'many → one'
  | 'many → many'
  | 'one → one'
  | 'one → zero or one';

export const DATABASE_UNVERIFIED_NOTICE =
  'ER diagrams describe schema definitions and database state is unverified. Verifying an actual database requires a later, explicit introspection connection. Live database was not checked.';

export const COMMON_FIELD_TYPES = [
  'String',
  'Int',
  'BigInt',
  'Boolean',
  'DateTime',
  'Float',
  'Decimal',
  'Json',
  'Bytes',
] as const;

export const CARDINALITY_OPTIONS: { value: CardinalityType; label: string; description: string }[] = [
  { value: 'one → many', label: 'One to Many (1:N)', description: 'One source entity relates to multiple target entities' },
  { value: 'many → one', label: 'Many to One (N:1)', description: 'Multiple source entities relate to one target entity' },
  { value: 'many → many', label: 'Many to Many (M:N)', description: 'Multiple source entities relate to multiple target entities' },
  { value: 'one → one', label: 'One to One (1:1)', description: 'One source entity relates to exactly one target entity' },
  { value: 'one → zero or one', label: 'One to Optional (1:0..1)', description: 'One source entity relates to zero or one target entity' },
];

/**
 * Extracts the mapped database table name from an entity node description or contract.
 */
export function getMappedTableName(node: ProgramNode): string | undefined {
  if (node.kind !== 'entity') return undefined;
  if (node.mappedName) return node.mappedName;
  if (node.description) {
    const match = node.description.match(/Database name:\s*([^\s;,\n]+)/i);
    if (match) return match[1];
    const mapMatch = node.description.match(/@@map\(["']([^"']+)["']\)/);
    if (mapMatch) return mapMatch[1];
  }
  if (node.contract) {
    const mapMatch = node.contract.match(/@@map\(["']([^"']+)["']\)/);
    if (mapMatch) return mapMatch[1];
  }
  return undefined;
}

/**
 * Formats a relationship label preserving cardinality and foreign key field associations.
 */
export function formatRelationshipLabel(cardinality: string, foreignKeyFields?: string[]): string {
  const normCard = cardinality.trim();
  const fks = (foreignKeyFields || []).map(f => f.trim()).filter(Boolean);
  if (fks.length > 0) {
    return `${normCard} · ${fks.join(', ')}`;
  }
  return normCard;
}

/**
 * Parses a relationship label into cardinality and associated foreign key fields.
 */
export function parseRelationshipLabel(label: string): { cardinality: string; foreignKeys: string[] } {
  if (!label || !label.trim()) {
    return { cardinality: 'one → many', foreignKeys: [] };
  }
  const parts = label.split('·');
  const cardinality = parts[0].trim();
  const foreignKeys = parts[1]
    ? parts[1].split(',').map(f => f.trim()).filter(Boolean)
    : [];
  return { cardinality, foreignKeys };
}

/**
 * Creates an entity node in the graph and validates containment and schema.
 */
export function createEntityNode(
  graph: Graph,
  input: {
    name: string;
    parentId?: string;
    description?: string;
    mappedTableName?: string;
    policy?: ProgramNode['policy'];
    contract?: string;
    outputPath?: string;
    fields?: EntityField[];
    id?: string;
  }
): { graph: Graph; node: ProgramNode } {
  const name = input.name.trim();
  if (!name) {
    throw new Error('Entity name must not be blank');
  }

  if (input.parentId) {
    const parent = graph.nodes.find(n => n.id === input.parentId);
    if (!parent) {
      throw new Error(`Parent node does not exist: ${input.parentId}`);
    }
    if (!validRelationship('contains', parent.kind, 'entity')) {
      throw new Error(`Invalid nesting: ${parent.kind} cannot contain entity`);
    }
  }

  const nodeId = input.id || createNodeId();
  if (graph.nodes.some(n => n.id === nodeId)) {
    throw new Error(`Duplicate node ID: ${nodeId}`);
  }

  let description = input.description?.trim() || '';
  if (input.mappedTableName?.trim()) {
    const mapped = input.mappedTableName.trim();
    if (!description.includes('Database name:')) {
      description = description ? `${description} · Database name: ${mapped}` : `Database name: ${mapped}`;
    }
  }

  const formattedFields = (input.fields || []).map(f => ({
    name: f.name.trim(),
    type: f.type.trim(),
    key: f.key?.trim() || '',
    optional: !!f.optional,
    mappedName: f.mappedName?.trim() || undefined,
    defaultValue: f.defaultValue?.trim() || undefined,
    source: f.source,
  }));

  const mappedTable = input.mappedTableName?.trim();
  const newNode: ProgramNode = {
    id: nodeId,
    kind: 'entity',
    name,
    parentId: input.parentId || undefined,
    description,
    provenance: 'human',
    policy: input.policy || 'editable',
    contract: input.contract?.trim() || '',
    requiredChecks: [],
    instructions: '',
    outputPath: input.outputPath?.trim() || '',
    fields: formattedFields,
    ...(mappedTable ? { mappedName: mappedTable } : {}),
  };

  const nextGraph: Graph = {
    ...graph,
    nodes: [...graph.nodes, newNode],
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after creating entity');
  }

  return { graph: validation.data, node: newNode };
}

/**
 * Updates an entity node (name, table mapping, parent container, fields, description).
 */
export function updateEntityNode(
  graph: Graph,
  entityId: string,
  updates: {
    name?: string;
    description?: string;
    mappedTableName?: string;
    parentId?: string | null;
    policy?: ProgramNode['policy'];
    contract?: string;
    outputPath?: string;
    fields?: EntityField[];
  }
): { graph: Graph; node: ProgramNode } {
  const existingNode = graph.nodes.find(n => n.id === entityId);
  if (!existingNode) {
    throw new Error(`Entity not found: ${entityId}`);
  }
  if (existingNode.kind !== 'entity') {
    throw new Error(`Node ${entityId} is not an entity (found: ${existingNode.kind})`);
  }

  const nextName = updates.name !== undefined ? updates.name.trim() : existingNode.name;
  if (!nextName) {
    throw new Error('Entity name must not be blank');
  }

  let nextParentId = existingNode.parentId;
  if (updates.parentId !== undefined) {
    if (updates.parentId === null || updates.parentId === '') {
      nextParentId = undefined;
    } else {
      if (updates.parentId === entityId) {
        throw new Error('An entity cannot be its own parent');
      }
      const parentNode = graph.nodes.find(n => n.id === updates.parentId);
      if (!parentNode) {
        throw new Error(`Parent node does not exist: ${updates.parentId}`);
      }
      if (!validRelationship('contains', parentNode.kind, 'entity')) {
        throw new Error(`Invalid nesting: ${parentNode.kind} cannot contain entity`);
      }
      nextParentId = updates.parentId;
    }
  }

  let nextDescription = updates.description !== undefined ? updates.description.trim() : existingNode.description;
  if (updates.mappedTableName !== undefined) {
    const rawDescWithoutDb = nextDescription.replace(/(?:·\s*)?Database name:\s*([^\s;,\n]+)/gi, '').trim();
    if (updates.mappedTableName.trim()) {
      const mapped = updates.mappedTableName.trim();
      nextDescription = rawDescWithoutDb
        ? `${rawDescWithoutDb} · Database name: ${mapped}`
        : `Database name: ${mapped}`;
    } else {
      nextDescription = rawDescWithoutDb;
    }
  }

  const nextFields = updates.fields !== undefined
    ? updates.fields.map(f => ({
        name: f.name.trim(),
        type: f.type.trim(),
        key: f.key?.trim() || '',
        optional: !!f.optional,
        mappedName: f.mappedName?.trim() || undefined,
        defaultValue: f.defaultValue?.trim() || undefined,
        source: f.source,
      }))
    : existingNode.fields;

  const mappedTable = updates.mappedTableName !== undefined
    ? (updates.mappedTableName.trim() || undefined)
    : existingNode.mappedName;

  const updatedNode: ProgramNode = {
    ...existingNode,
    name: nextName,
    description: nextDescription,
    parentId: nextParentId,
    policy: updates.policy !== undefined ? updates.policy : existingNode.policy,
    contract: updates.contract !== undefined ? updates.contract.trim() : existingNode.contract,
    outputPath: updates.outputPath !== undefined ? updates.outputPath.trim() : existingNode.outputPath,
    fields: nextFields,
    mappedName: mappedTable,
  };

  const nextGraph: Graph = {
    ...graph,
    nodes: graph.nodes.map(n => (n.id === entityId ? updatedNode : n)),
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after updating entity');
  }

  return { graph: validation.data, node: updatedNode };
}

/**
 * Removes an entity node, cascades edge deletion, and cleans up requirements.
 */
export function removeEntityNode(
  graph: Graph,
  entityId: string
): {
  graph: Graph;
  removedNode: ProgramNode;
  removedEdges: ProgramEdge[];
  preservedRequirements: Requirement[];
} {
  const targetNode = graph.nodes.find(n => n.id === entityId);
  if (!targetNode) {
    throw new Error(`Entity not found: ${entityId}`);
  }

  const removedEdges = graph.edges.filter(e => e.source === entityId || e.target === entityId);
  const removedEdgeIds = new Set(removedEdges.map(e => e.id));

  const remainingNodes = graph.nodes
    .filter(n => n.id !== entityId)
    .map(n => {
      if (n.parentId === entityId) {
        return { ...n, parentId: targetNode.parentId };
      }
      return n;
    });

  const remainingEdges = graph.edges.filter(e => e.source !== entityId && e.target !== entityId);

  const preservedRequirements = graph.requirements.map(req => ({
    ...req,
    nodeIds: req.nodeIds.filter(nid => nid !== entityId),
    edgeIds: req.edgeIds.filter(eid => !removedEdgeIds.has(eid)),
  }));

  const nextGraph: Graph = {
    ...graph,
    nodes: remainingNodes,
    edges: remainingEdges,
    requirements: preservedRequirements,
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after removing entity');
  }

  return {
    graph: validation.data,
    removedNode: targetNode,
    removedEdges,
    preservedRequirements,
  };
}

/**
 * Adds a field to an entity with type, nullability, key, and database column mapping.
 */
export function addEntityField(
  graph: Graph,
  entityId: string,
  field: EntityField
): { graph: Graph; node: ProgramNode; field: EntityField } {
  const entity = graph.nodes.find(n => n.id === entityId);
  if (!entity) {
    throw new Error(`Entity not found: ${entityId}`);
  }
  const fieldName = field.name.trim();
  if (!fieldName) {
    throw new Error('Field name must not be blank');
  }
  if (!field.type.trim()) {
    throw new Error('Field type must not be blank');
  }
  if (entity.fields.some(f => f.name === fieldName)) {
    throw new Error(`Field "${fieldName}" already exists on entity "${entity.name}"`);
  }

  const formattedField = {
    name: fieldName,
    type: field.type.trim(),
    key: field.key?.trim() || '',
    optional: !!field.optional,
    mappedName: field.mappedName?.trim() || undefined,
    defaultValue: field.defaultValue?.trim() || undefined,
    source: field.source,
  };

  const updatedNode: ProgramNode = {
    ...entity,
    fields: [...entity.fields, formattedField],
  };

  const nextGraph: Graph = {
    ...graph,
    nodes: graph.nodes.map(n => (n.id === entityId ? updatedNode : n)),
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after adding field');
  }

  return { graph: validation.data, node: updatedNode, field: formattedField };
}

/**
 * Updates a field on an entity by index or field name.
 */
export function updateEntityField(
  graph: Graph,
  entityId: string,
  fieldIdentifier: number | string,
  updates: Partial<EntityField>
): { graph: Graph; node: ProgramNode } {
  const entity = graph.nodes.find(n => n.id === entityId);
  if (!entity) {
    throw new Error(`Entity not found: ${entityId}`);
  }

  const fieldIndex = typeof fieldIdentifier === 'number'
    ? fieldIdentifier
    : entity.fields.findIndex(f => f.name === fieldIdentifier);

  if (fieldIndex < 0 || fieldIndex >= entity.fields.length) {
    throw new Error(`Field not found on entity "${entity.name}": ${fieldIdentifier}`);
  }

  const currentField = entity.fields[fieldIndex];
  const nextName = updates.name !== undefined ? updates.name.trim() : currentField.name;
  if (!nextName) {
    throw new Error('Field name must not be blank');
  }

  if (nextName !== currentField.name && entity.fields.some((f, idx) => idx !== fieldIndex && f.name === nextName)) {
    throw new Error(`Field "${nextName}" already exists on entity "${entity.name}"`);
  }

  const nextField = {
    name: nextName,
    type: updates.type !== undefined ? updates.type.trim() : currentField.type,
    key: updates.key !== undefined ? updates.key.trim() : currentField.key,
    optional: updates.optional !== undefined ? !!updates.optional : currentField.optional,
    mappedName: updates.mappedName !== undefined
      ? (updates.mappedName.trim() || undefined)
      : currentField.mappedName,
    defaultValue: updates.defaultValue !== undefined
      ? (updates.defaultValue.trim() || undefined)
      : currentField.defaultValue,
    source: updates.source !== undefined ? updates.source : currentField.source,
  };

  const nextFields = [...entity.fields];
  nextFields[fieldIndex] = nextField;

  const updatedNode: ProgramNode = {
    ...entity,
    fields: nextFields,
  };

  const nextGraph: Graph = {
    ...graph,
    nodes: graph.nodes.map(n => (n.id === entityId ? updatedNode : n)),
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after updating field');
  }

  return { graph: validation.data, node: updatedNode };
}

/**
 * Removes a field from an entity.
 */
export function removeEntityField(
  graph: Graph,
  entityId: string,
  fieldIdentifier: number | string
): { graph: Graph; node: ProgramNode; removedField: EntityField } {
  const entity = graph.nodes.find(n => n.id === entityId);
  if (!entity) {
    throw new Error(`Entity not found: ${entityId}`);
  }

  const fieldIndex = typeof fieldIdentifier === 'number'
    ? fieldIdentifier
    : entity.fields.findIndex(f => f.name === fieldIdentifier);

  if (fieldIndex < 0 || fieldIndex >= entity.fields.length) {
    throw new Error(`Field not found on entity "${entity.name}": ${fieldIdentifier}`);
  }

  const removedField = entity.fields[fieldIndex];
  const nextFields = entity.fields.filter((_, idx) => idx !== fieldIndex);

  const updatedNode: ProgramNode = {
    ...entity,
    fields: nextFields,
  };

  const nextGraph: Graph = {
    ...graph,
    nodes: graph.nodes.map(n => (n.id === entityId ? updatedNode : n)),
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after removing field');
  }

  return { graph: validation.data, node: updatedNode, removedField };
}

/**
 * Sets a composite primary or unique key across multiple fields of an entity.
 */
export function setCompositeKey(
  graph: Graph,
  entityId: string,
  fieldNames: string[],
  keyType: 'PK' | 'UNIQUE' = 'PK'
): { graph: Graph; node: ProgramNode } {
  const entity = graph.nodes.find(n => n.id === entityId);
  if (!entity) {
    throw new Error(`Entity not found: ${entityId}`);
  }

  if (fieldNames.length === 0) {
    throw new Error('Composite key requires at least one field');
  }

  for (const fn of fieldNames) {
    if (!entity.fields.some(f => f.name === fn)) {
      throw new Error(`Field "${fn}" does not exist on entity "${entity.name}"`);
    }
  }

  const targetNamesSet = new Set(fieldNames);
  const compositeKeyBadge = keyType === 'PK' ? 'PK (composite)' : 'UNIQUE (composite)';

  const nextFields = entity.fields.map(f => {
    if (targetNamesSet.has(f.name)) {
      return { ...f, key: compositeKeyBadge };
    }
    // If it previously had a composite key of this type and is no longer included, reset key
    if (f.key === compositeKeyBadge) {
      return { ...f, key: '' };
    }
    return f;
  });

  const existingCompositeKeys = entity.compositeKeys || [];
  const filteredKeys = existingCompositeKeys.filter(k => k.type !== keyType);
  const updatedCompositeKeys = [...filteredKeys, { fields: fieldNames, type: keyType }];

  const updatedNode: ProgramNode = {
    ...entity,
    fields: nextFields,
    compositeKeys: updatedCompositeKeys,
  };

  const nextGraph: Graph = {
    ...graph,
    nodes: graph.nodes.map(n => (n.id === entityId ? updatedNode : n)),
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after setting composite key');
  }

  return { graph: validation.data, node: updatedNode };
}

/**
 * Creates an enum node in the graph and stores its member values.
 */
export function createEnumNode(
  graph: Graph,
  input: {
    name: string;
    parentId?: string;
    description?: string;
    members?: (string | { name: string; mappedName?: string })[];
    policy?: ProgramNode['policy'];
    outputPath?: string;
    id?: string;
  }
): { graph: Graph; node: ProgramNode } {
  const name = input.name.trim();
  if (!name) {
    throw new Error('Enum name must not be blank');
  }

  if (input.parentId) {
    const parent = graph.nodes.find(n => n.id === input.parentId);
    if (!parent) {
      throw new Error(`Parent node does not exist: ${input.parentId}`);
    }
    if (!validRelationship('contains', parent.kind, 'enum')) {
      throw new Error(`Invalid nesting: ${parent.kind} cannot contain enum`);
    }
  }

  const nodeId = input.id || createNodeId();
  if (graph.nodes.some(n => n.id === nodeId)) {
    throw new Error(`Duplicate node ID: ${nodeId}`);
  }

  const fields = (input.members || []).map(m => {
    const memberName = typeof m === 'string' ? m.trim() : m.name.trim();
    const mapped = typeof m === 'object' && m.mappedName ? m.mappedName.trim() : undefined;
    return {
      name: memberName,
      type: 'enum',
      key: '',
      optional: false,
      mappedName: mapped || undefined,
    };
  });

  const newNode: ProgramNode = {
    id: nodeId,
    kind: 'enum',
    name,
    parentId: input.parentId || undefined,
    description: input.description?.trim() || '',
    provenance: 'human',
    policy: input.policy || 'editable',
    contract: `enum ${name} { ${fields.map(f => f.name).join(', ')} }`,
    requiredChecks: [],
    instructions: '',
    outputPath: input.outputPath?.trim() || '',
    fields,
  };

  const nextGraph: Graph = {
    ...graph,
    nodes: [...graph.nodes, newNode],
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after creating enum');
  }

  return { graph: validation.data, node: newNode };
}

/**
 * Updates an enum node and its member values.
 */
export function updateEnumNode(
  graph: Graph,
  enumId: string,
  updates: {
    name?: string;
    description?: string;
    members?: (string | { name: string; mappedName?: string })[];
    parentId?: string | null;
    policy?: ProgramNode['policy'];
    outputPath?: string;
  }
): { graph: Graph; node: ProgramNode } {
  const existingNode = graph.nodes.find(n => n.id === enumId);
  if (!existingNode) {
    throw new Error(`Enum not found: ${enumId}`);
  }
  if (existingNode.kind !== 'enum') {
    throw new Error(`Node ${enumId} is not an enum (found: ${existingNode.kind})`);
  }

  const nextName = updates.name !== undefined ? updates.name.trim() : existingNode.name;
  if (!nextName) {
    throw new Error('Enum name must not be blank');
  }

  let nextParentId = existingNode.parentId;
  if (updates.parentId !== undefined) {
    if (updates.parentId === null || updates.parentId === '') {
      nextParentId = undefined;
    } else {
      const parentNode = graph.nodes.find(n => n.id === updates.parentId);
      if (!parentNode) {
        throw new Error(`Parent node does not exist: ${updates.parentId}`);
      }
      if (!validRelationship('contains', parentNode.kind, 'enum')) {
        throw new Error(`Invalid nesting: ${parentNode.kind} cannot contain enum`);
      }
      nextParentId = updates.parentId;
    }
  }

  const nextFields = updates.members !== undefined
    ? updates.members.map(m => {
        const memberName = typeof m === 'string' ? m.trim() : m.name.trim();
        const mapped = typeof m === 'object' && m.mappedName ? m.mappedName.trim() : undefined;
        return {
          name: memberName,
          type: 'enum',
          key: '',
          optional: false,
          mappedName: mapped || undefined,
        };
      })
    : existingNode.fields;

  const updatedNode: ProgramNode = {
    ...existingNode,
    name: nextName,
    description: updates.description !== undefined ? updates.description.trim() : existingNode.description,
    parentId: nextParentId,
    policy: updates.policy !== undefined ? updates.policy : existingNode.policy,
    contract: `enum ${nextName} { ${nextFields.map(f => f.name).join(', ')} }`,
    outputPath: updates.outputPath !== undefined ? updates.outputPath.trim() : existingNode.outputPath,
    fields: nextFields,
  };

  const nextGraph: Graph = {
    ...graph,
    nodes: graph.nodes.map(n => (n.id === enumId ? updatedNode : n)),
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after updating enum');
  }

  return { graph: validation.data, node: updatedNode };
}

/**
 * Removes an enum node.
 */
export function removeEnumNode(
  graph: Graph,
  enumId: string
): { graph: Graph; node: ProgramNode; removedNode: ProgramNode } {
  const existingNode = graph.nodes.find(n => n.id === enumId);
  if (!existingNode) {
    throw new Error(`Enum not found: ${enumId}`);
  }

  const remainingNodes = graph.nodes.filter(n => n.id !== enumId);
  const remainingEdges = graph.edges.filter(e => e.source !== enumId && e.target !== enumId);

  const nextGraph: Graph = {
    ...graph,
    nodes: remainingNodes,
    edges: remainingEdges,
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after removing enum');
  }

  return { graph: validation.data, node: existingNode, removedNode: existingNode };
}

/**
 * Creates an ER relationship edge between two entities, validating cardinality and field associations.
 */
export function createEntityRelationship(
  graph: Graph,
  input: {
    sourceEntityId: string;
    targetEntityId: string;
    cardinality: CardinalityType | string;
    foreignKeyFields?: string[];
    label?: string;
    id?: string;
    markForeignKeyOnSource?: boolean;
  }
): { graph: Graph; edge: ProgramEdge } {
  const sourceNode = graph.nodes.find(n => n.id === input.sourceEntityId);
  const targetNode = graph.nodes.find(n => n.id === input.targetEntityId);

  if (!sourceNode) {
    throw new Error(`Source entity not found: ${input.sourceEntityId}`);
  }
  if (!targetNode) {
    throw new Error(`Target entity not found: ${input.targetEntityId}`);
  }
  if (sourceNode.kind !== 'entity') {
    throw new Error(`Source must be an entity (found: ${sourceNode.kind})`);
  }
  if (targetNode.kind !== 'entity') {
    throw new Error(`Target must be an entity (found: ${targetNode.kind})`);
  }

  if (!validRelationship('relates-to', 'entity', 'entity')) {
    throw new Error('Invalid relationship: entity to entity relates-to is not permitted');
  }

  const label = input.label !== undefined && input.label.trim()
    ? input.label.trim()
    : formatRelationshipLabel(input.cardinality, input.foreignKeyFields);

  const edgeId = input.id || createNodeId();
  if (graph.edges.some(e => e.id === edgeId)) {
    throw new Error(`Duplicate edge ID: ${edgeId}`);
  }

  const newEdge: ProgramEdge = {
    id: edgeId,
    source: input.sourceEntityId,
    target: input.targetEntityId,
    kind: 'relates-to',
    label,
    provenance: 'human',
    uncertain: false,
  };

  // Optionally mark foreign key field(s) on source entity
  let updatedNodes = graph.nodes;
  if (input.markForeignKeyOnSource && input.foreignKeyFields && input.foreignKeyFields.length > 0) {
    const fkSet = new Set(input.foreignKeyFields.map(f => f.trim()));
    updatedNodes = graph.nodes.map(node => {
      if (node.id === input.sourceEntityId) {
        const nextFields = node.fields.map(f => {
          if (fkSet.has(f.name) && !f.key) {
            return { ...f, key: 'FK' };
          }
          return f;
        });
        return { ...node, fields: nextFields };
      }
      return node;
    });
  }

  const nextGraph: Graph = {
    ...graph,
    nodes: updatedNodes,
    edges: [...graph.edges, newEdge],
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after creating relationship');
  }

  return { graph: validation.data, edge: newEdge };
}

/**
 * Updates an existing ER relationship edge (cardinality, field associations, label).
 */
export function updateEntityRelationship(
  graph: Graph,
  edgeId: string,
  updates: {
    cardinality?: CardinalityType | string;
    foreignKeyFields?: string[];
    label?: string;
  }
): { graph: Graph; edge: ProgramEdge } {
  const existingEdge = graph.edges.find(e => e.id === edgeId);
  if (!existingEdge) {
    throw new Error(`Relationship edge not found: ${edgeId}`);
  }
  if (existingEdge.kind !== 'relates-to') {
    throw new Error(`Edge is not an ER relationship (kind: ${existingEdge.kind})`);
  }

  let nextLabel = existingEdge.label;
  if (updates.label !== undefined && updates.label.trim()) {
    nextLabel = updates.label.trim();
  } else if (updates.cardinality !== undefined || updates.foreignKeyFields !== undefined) {
    const parsed = parseRelationshipLabel(existingEdge.label);
    const card = updates.cardinality !== undefined ? updates.cardinality : parsed.cardinality;
    const fks = updates.foreignKeyFields !== undefined ? updates.foreignKeyFields : parsed.foreignKeys;
    nextLabel = formatRelationshipLabel(card, fks);
  }

  const updatedEdge: ProgramEdge = {
    ...existingEdge,
    label: nextLabel,
  };

  const nextGraph: Graph = {
    ...graph,
    edges: graph.edges.map(e => (e.id === edgeId ? updatedEdge : e)),
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after updating relationship');
  }

  return { graph: validation.data, edge: updatedEdge };
}

/**
 * Removes an ER relationship edge.
 */
export function removeEntityRelationship(
  graph: Graph,
  edgeId: string
): { graph: Graph; removedEdge: ProgramEdge; preservedRequirements: Requirement[] } {
  const existingEdge = graph.edges.find(e => e.id === edgeId);
  if (!existingEdge) {
    throw new Error(`Relationship edge not found: ${edgeId}`);
  }

  const remainingEdges = graph.edges.filter(e => e.id !== edgeId);
  const remainingReqs = graph.requirements.map(req => ({
    ...req,
    edgeIds: req.edgeIds.filter(eid => eid !== edgeId),
  }));

  const nextGraph: Graph = {
    ...graph,
    edges: remainingEdges,
    requirements: remainingReqs,
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after removing relationship');
  }

  return { graph: validation.data, removedEdge: existingEdge, preservedRequirements: remainingReqs };
}

export interface ErEditorProps {
  project?: Project | null;
  graph: Graph | null;
  onUpdateSpecification?: (nextGraph: Graph) => void | Promise<void>;
  selectedNodeId?: string | null;
  onSelectNode?: (id: string | null) => void;
  isOpen?: boolean;
  onClose?: () => void;
  mode?: 'modal' | 'panel' | 'inline';
  readOnly?: boolean;
  initialTab?: 'entities' | 'fields' | 'enums' | 'relationships';
}

export const ErEditor: React.FC<ErEditorProps> = ({
  project,
  graph,
  onUpdateSpecification,
  selectedNodeId,
  onSelectNode,
  isOpen = true,
  onClose,
  mode = 'modal',
  readOnly = false,
  initialTab = 'entities',
}) => {
  const currentGraph = useMemo(() => graph || emptyGraph(), [graph]);

  const [activeTab, setActiveTab] = useState<'entities' | 'fields' | 'enums' | 'relationships'>(initialTab);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Entities & Enums
  const entities = useMemo(() => currentGraph.nodes.filter(n => n.kind === 'entity'), [currentGraph]);
  const enums = useMemo(() => currentGraph.nodes.filter(n => n.kind === 'enum'), [currentGraph]);
  const modules = useMemo(() => currentGraph.nodes.filter(n => ['module', 'system'].includes(n.kind)), [currentGraph]);
  const relationships = useMemo(() => currentGraph.edges.filter(e => e.kind === 'relates-to'), [currentGraph]);

  // Selected entity for field editing
  const [activeEntityId, setActiveEntityId] = useState<string>(() => {
    if (selectedNodeId) {
      const selected = currentGraph.nodes.find(n => n.id === selectedNodeId);
      if (selected?.kind === 'entity') return selected.id;
    }
    const firstEntity = currentGraph.nodes.find(n => n.kind === 'entity');
    return firstEntity ? firstEntity.id : '';
  });

  useEffect(() => {
    if (selectedNodeId) {
      const selected = currentGraph.nodes.find(n => n.id === selectedNodeId);
      if (selected?.kind === 'entity') {
        setActiveEntityId(selected.id);
        setActiveTab('fields');
      } else if (selected?.kind === 'enum') {
        setActiveTab('enums');
      }
    } else if (!activeEntityId && entities.length > 0) {
      setActiveEntityId(entities[0].id);
    }
  }, [selectedNodeId, currentGraph, entities, activeEntityId]);

  const activeEntity = useMemo(() => entities.find(e => e.id === activeEntityId) || null, [entities, activeEntityId]);

  // Form states: Create Entity
  const [newEntityName, setNewEntityName] = useState('');
  const [newEntityParent, setNewEntityParent] = useState('');
  const [newEntityMappedTable, setNewEntityMappedTable] = useState('');
  const [newEntityDescription, setNewEntityDescription] = useState('');

  // Form states: Field Editor
  const [fieldName, setFieldName] = useState('');
  const [fieldType, setFieldType] = useState('String');
  const [fieldOptional, setFieldOptional] = useState(false);
  const [fieldKey, setFieldKey] = useState('');
  const [fieldMappedName, setFieldMappedName] = useState('');
  const [editingFieldIndex, setEditingFieldIndex] = useState<number | null>(null);

  // Form states: Composite Key
  const [compositeKeyFields, setCompositeKeyFields] = useState<string[]>([]);
  const [compositeKeyType, setCompositeKeyType] = useState<'PK' | 'UNIQUE'>('PK');

  // Form states: Create/Edit Enum
  const [newEnumName, setNewEnumName] = useState('');
  const [newEnumParent, setNewEnumParent] = useState('');
  const [newEnumMemberInput, setNewEnumMemberInput] = useState('');
  const [newEnumMembers, setNewEnumMembers] = useState<string[]>([]);
  const [selectedEnumId, setSelectedEnumId] = useState<string>('');

  // Form states: Relationships
  const [relSourceId, setRelSourceId] = useState('');
  const [relTargetId, setRelTargetId] = useState('');
  const [relCardinality, setRelCardinality] = useState<CardinalityType>('one → many');
  const [relForeignKeys, setRelForeignKeys] = useState('');
  const [relCustomLabel, setRelCustomLabel] = useState('');
  const [relAutoMarkFk, setRelAutoMarkFk] = useState(true);

  const clearMessages = () => {
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  // Handlers
  const handleCreateEntity = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();
    try {
      const { graph: updatedGraph, node } = createEntityNode(currentGraph, {
        name: newEntityName,
        parentId: newEntityParent || undefined,
        mappedTableName: newEntityMappedTable || undefined,
        description: newEntityDescription || undefined,
      });

      if (onUpdateSpecification) {
        await onUpdateSpecification(updatedGraph);
      }
      setSuccessMessage(`Entity "${node.name}" created successfully.`);
      setNewEntityName('');
      setNewEntityMappedTable('');
      setNewEntityDescription('');
      setActiveEntityId(node.id);
      setActiveTab('fields');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to create entity');
    }
  };

  const handleUpdateActiveEntityTableMapping = async (mappedTable: string) => {
    if (!activeEntity) return;
    clearMessages();
    try {
      const { graph: updatedGraph } = updateEntityNode(currentGraph, activeEntity.id, {
        mappedTableName: mappedTable,
      });
      if (onUpdateSpecification) {
        await onUpdateSpecification(updatedGraph);
      }
      setSuccessMessage(`Database table mapping updated for "${activeEntity.name}".`);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to update table mapping');
    }
  };

  const handleDeleteEntity = async (entityId: string) => {
    clearMessages();
    try {
      const { graph: updatedGraph, removedNode } = removeEntityNode(currentGraph, entityId);
      if (onUpdateSpecification) {
        await onUpdateSpecification(updatedGraph);
      }
      setSuccessMessage(`Entity "${removedNode.name}" deleted.`);
      if (activeEntityId === entityId) {
        const remaining = updatedGraph.nodes.filter(n => n.kind === 'entity');
        setActiveEntityId(remaining.length > 0 ? remaining[0].id : '');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to delete entity');
    }
  };

  const handleSaveField = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeEntity) return;
    clearMessages();

    try {
      let updatedGraph: Graph;
      if (editingFieldIndex !== null) {
        const res = updateEntityField(currentGraph, activeEntity.id, editingFieldIndex, {
          name: fieldName,
          type: fieldType,
          optional: fieldOptional,
          key: fieldKey,
          mappedName: fieldMappedName,
        });
        updatedGraph = res.graph;
        setSuccessMessage(`Field "${fieldName}" updated.`);
      } else {
        const res = addEntityField(currentGraph, activeEntity.id, {
          name: fieldName,
          type: fieldType,
          optional: fieldOptional,
          key: fieldKey,
          mappedName: fieldMappedName,
        });
        updatedGraph = res.graph;
        setSuccessMessage(`Field "${fieldName}" added.`);
      }

      if (onUpdateSpecification) {
        await onUpdateSpecification(updatedGraph);
      }
      // Reset field form
      setFieldName('');
      setFieldType('String');
      setFieldOptional(false);
      setFieldKey('');
      setFieldMappedName('');
      setEditingFieldIndex(null);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to save field');
    }
  };

  const handleEditFieldClick = (index: number) => {
    if (!activeEntity) return;
    const f = activeEntity.fields[index];
    setFieldName(f.name);
    setFieldType(f.type);
    setFieldOptional(!!f.optional);
    setFieldKey(f.key || '');
    setFieldMappedName(f.mappedName || '');
    setEditingFieldIndex(index);
  };

  const handleDeleteField = async (index: number) => {
    if (!activeEntity) return;
    clearMessages();
    try {
      const { graph: updatedGraph, removedField } = removeEntityField(currentGraph, activeEntity.id, index);
      if (onUpdateSpecification) {
        await onUpdateSpecification(updatedGraph);
      }
      setSuccessMessage(`Field "${removedField.name}" deleted.`);
      if (editingFieldIndex === index) {
        setEditingFieldIndex(null);
        setFieldName('');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to delete field');
    }
  };

  const handleApplyCompositeKey = async () => {
    if (!activeEntity) return;
    clearMessages();
    try {
      const { graph: updatedGraph } = setCompositeKey(
        currentGraph,
        activeEntity.id,
        compositeKeyFields,
        compositeKeyType
      );
      if (onUpdateSpecification) {
        await onUpdateSpecification(updatedGraph);
      }
      setSuccessMessage(`Composite ${compositeKeyType} key set on [${compositeKeyFields.join(', ')}].`);
      setCompositeKeyFields([]);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to set composite key');
    }
  };

  const handleAddEnumMember = () => {
    const val = newEnumMemberInput.trim().toUpperCase();
    if (!val) return;
    if (newEnumMembers.includes(val)) {
      setErrorMessage(`Enum member "${val}" already exists`);
      return;
    }
    setNewEnumMembers(prev => [...prev, val]);
    setNewEnumMemberInput('');
  };

  const handleRemoveEnumMember = (val: string) => {
    setNewEnumMembers(prev => prev.filter(m => m !== val));
  };

  const handleCreateEnum = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();
    try {
      const { graph: updatedGraph, node } = createEnumNode(currentGraph, {
        name: newEnumName,
        parentId: newEnumParent || undefined,
        members: newEnumMembers,
      });
      if (onUpdateSpecification) {
        await onUpdateSpecification(updatedGraph);
      }
      setSuccessMessage(`Enum "${node.name}" created with ${newEnumMembers.length} member(s).`);
      setNewEnumName('');
      setNewEnumMembers([]);
      setSelectedEnumId(node.id);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to create enum');
    }
  };

  const handleDeleteEnum = async (enumId: string) => {
    clearMessages();
    try {
      const { graph: updatedGraph, node } = removeEnumNode(currentGraph, enumId);
      if (onUpdateSpecification) {
        await onUpdateSpecification(updatedGraph);
      }
      setSuccessMessage(`Enum "${node.name}" deleted.`);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to delete enum');
    }
  };

  const handleCreateRelationship = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();
    try {
      const fks = relForeignKeys.split(',').map(s => s.trim()).filter(Boolean);
      const { graph: updatedGraph } = createEntityRelationship(currentGraph, {
        sourceEntityId: relSourceId,
        targetEntityId: relTargetId,
        cardinality: relCardinality,
        foreignKeyFields: fks,
        label: relCustomLabel || undefined,
        markForeignKeyOnSource: relAutoMarkFk,
      });

      if (onUpdateSpecification) {
        await onUpdateSpecification(updatedGraph);
      }
      setSuccessMessage('ER relationship created successfully.');
      setRelCustomLabel('');
      setRelForeignKeys('');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to create relationship');
    }
  };

  const handleDeleteRelationship = async (edgeId: string) => {
    clearMessages();
    try {
      const { graph: updatedGraph } = removeEntityRelationship(currentGraph, edgeId);
      if (onUpdateSpecification) {
        await onUpdateSpecification(updatedGraph);
      }
      setSuccessMessage('Relationship removed.');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to delete relationship');
    }
  };

  if (mode === 'modal' && !isOpen) {
    return null;
  }

  const content = (
    <div className="er-editor-container" data-testid="er-editor-container">
      {/* 1. Header with explicit title and close action */}
      <div className="er-editor-header">
        <div className="er-header-title">
          <Database size={18} className="er-header-icon" />
          <h2>ER Schema Editor</h2>
          <span className="er-subtitle">Entities, Fields, Keys & Relationships</span>
        </div>
        {onClose && (
          <button
            type="button"
            className="btn-close-er"
            onClick={onClose}
            title="Close ER Editor"
            data-testid="er-close-btn"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* 2. Database Unverified Disclaimer Banner (Crucial Requirement & Acceptance Criterion) */}
      <div className="er-unverified-notice" data-testid="er-database-unverified-notice">
        <Info size={16} className="notice-icon" />
        <div className="notice-text">
          <div className="notice-headline">
            <strong>Schema Definitions Only</strong>
            <span className="unverified-tag" data-testid="db-unverified-tag">Database Unverified</span>
          </div>
          <p className="notice-desc">
            ER diagrams describe schema definitions and database state is unverified.
            Verifying an actual database requires a later, explicit introspection connection.
            Live database was not checked.
          </p>
        </div>
      </div>

      {/* Status / Alert Messages */}
      {errorMessage && (
        <div className="er-alert er-alert-error" data-testid="er-error-banner">
          <AlertCircle size={14} />
          <span>{errorMessage}</span>
          <button type="button" onClick={() => setErrorMessage(null)} className="alert-close-btn"><X size={12} /></button>
        </div>
      )}
      {successMessage && (
        <div className="er-alert er-alert-success" data-testid="er-success-banner">
          <CheckCircle2 size={14} />
          <span>{successMessage}</span>
          <button type="button" onClick={() => setSuccessMessage(null)} className="alert-close-btn"><X size={12} /></button>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="er-tabs" role="tablist">
        <button
          type="button"
          className={`er-tab-btn ${activeTab === 'entities' ? 'active' : ''}`}
          onClick={() => { setActiveTab('entities'); clearMessages(); }}
          data-testid="er-tab-entities"
        >
          <Table size={14} />
          <span>Entities ({entities.length})</span>
        </button>
        <button
          type="button"
          className={`er-tab-btn ${activeTab === 'fields' ? 'active' : ''}`}
          onClick={() => { setActiveTab('fields'); clearMessages(); }}
          data-testid="er-tab-fields"
        >
          <Key size={14} />
          <span>Fields & Keys</span>
        </button>
        <button
          type="button"
          className={`er-tab-btn ${activeTab === 'enums' ? 'active' : ''}`}
          onClick={() => { setActiveTab('enums'); clearMessages(); }}
          data-testid="er-tab-enums"
        >
          <List size={14} />
          <span>Enums ({enums.length})</span>
        </button>
        <button
          type="button"
          className={`er-tab-btn ${activeTab === 'relationships' ? 'active' : ''}`}
          onClick={() => { setActiveTab('relationships'); clearMessages(); }}
          data-testid="er-tab-relationships"
        >
          <Link2 size={14} />
          <span>Relationships ({relationships.length})</span>
        </button>
      </div>

      {/* Tab Panels */}
      <div className="er-panel-body">
        {/* =====================================================================
            TAB 1: ENTITIES
            ===================================================================== */}
        {activeTab === 'entities' && (
          <div className="er-tab-content" data-testid="er-entities-panel">
            <div className="er-section-grid">
              {/* Form: Add Entity */}
              <div className="er-card">
                <div className="er-card-header">
                  <h3>Add Entity</h3>
                </div>
                <form onSubmit={handleCreateEntity} data-testid="er-create-entity-form">
                  <div className="form-group">
                    <label>Entity Name *</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="e.g. User, Order, Product"
                      value={newEntityName}
                      onChange={e => setNewEntityName(e.target.value)}
                      required
                      data-testid="er-new-entity-name"
                    />
                  </div>

                  <div className="form-group">
                    <label>Mapped Database Table Name</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="e.g. users, order_items (@@map)"
                      value={newEntityMappedTable}
                      onChange={e => setNewEntityMappedTable(e.target.value)}
                      data-testid="er-new-entity-mapped-table"
                    />
                    <span className="form-help">Maps entity to physical table name in database schema definitions.</span>
                  </div>

                  <div className="form-group">
                    <label>Parent Module / System</label>
                    <select
                      className="form-control"
                      value={newEntityParent}
                      onChange={e => setNewEntityParent(e.target.value)}
                      data-testid="er-new-entity-parent"
                    >
                      <option value="">None (Root ER Schema)</option>
                      {modules.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.kind})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Description</label>
                    <textarea
                      className="form-control"
                      rows={2}
                      placeholder="Purpose of this entity"
                      value={newEntityDescription}
                      onChange={e => setNewEntityDescription(e.target.value)}
                      data-testid="er-new-entity-desc"
                    />
                  </div>

                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={readOnly || !newEntityName.trim()}
                    data-testid="er-create-entity-submit"
                  >
                    <Plus size={14} />
                    <span>Create Entity</span>
                  </button>
                </form>
              </div>

              {/* List: Existing Entities */}
              <div className="er-card">
                <div className="er-card-header">
                  <h3>Existing Entities ({entities.length})</h3>
                </div>
                {entities.length === 0 ? (
                  <div className="er-empty-state">No entities defined yet. Create your first entity above.</div>
                ) : (
                  <div className="er-table-wrapper">
                    <table className="er-table" data-testid="er-entities-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Mapped Table</th>
                          <th>Fields</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entities.map(ent => {
                          const mappedTable = getMappedTableName(ent);
                          return (
                            <tr key={ent.id} className={ent.id === activeEntityId ? 'active-row' : ''}>
                              <td>
                                <strong>{ent.name}</strong>
                                {ent.parentId && (
                                  <span className="er-muted-parent"> (in {currentGraph.nodes.find(n => n.id === ent.parentId)?.name || ent.parentId})</span>
                                )}
                              </td>
                              <td>{mappedTable ? <code>{mappedTable}</code> : <span className="er-none">-</span>}</td>
                              <td>{ent.fields.length} field(s)</td>
                              <td className="er-actions-cell">
                                <button
                                  type="button"
                                  className="btn btn-xs btn-outline"
                                  onClick={() => {
                                    setActiveEntityId(ent.id);
                                    setActiveTab('fields');
                                  }}
                                  title={`Edit fields for ${ent.name}`}
                                  data-testid={`er-edit-entity-fields-${ent.id}`}
                                >
                                  <Key size={12} />
                                  <span>Fields</span>
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-xs btn-outline-danger"
                                  onClick={() => handleDeleteEntity(ent.id)}
                                  disabled={readOnly}
                                  title={`Delete entity ${ent.name}`}
                                  data-testid={`er-delete-entity-${ent.id}`}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* =====================================================================
            TAB 2: FIELDS & KEYS
            ===================================================================== */}
        {activeTab === 'fields' && (
          <div className="er-tab-content" data-testid="er-fields-panel">
            {entities.length === 0 ? (
              <div className="er-empty-state">
                <Table size={32} />
                <p>No entities found. Create an entity first before editing fields.</p>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => setActiveTab('entities')}
                >
                  Create Entity
                </button>
              </div>
            ) : (
              <div className="er-fields-layout">
                {/* Entity Selector Header */}
                <div className="er-entity-selector-bar">
                  <div className="selector-group">
                    <label>Select Entity:</label>
                    <select
                      className="form-control"
                      value={activeEntityId}
                      onChange={e => {
                        setActiveEntityId(e.target.value);
                        setEditingFieldIndex(null);
                        setFieldName('');
                      }}
                      data-testid="er-entity-select"
                    >
                      {entities.map(ent => (
                        <option key={ent.id} value={ent.id}>
                          {ent.name} ({ent.fields.length} fields)
                        </option>
                      ))}
                    </select>
                  </div>

                  {activeEntity && (
                    <div className="entity-mapping-inline">
                      <label>Mapped Table Name:</label>
                      <input
                        type="text"
                        className="form-control form-control-sm"
                        placeholder="e.g. order_items"
                        defaultValue={getMappedTableName(activeEntity) || ''}
                        onBlur={e => handleUpdateActiveEntityTableMapping(e.target.value)}
                        data-testid="er-active-entity-mapped-table"
                      />
                    </div>
                  )}
                </div>

                {activeEntity && (
                  <div className="er-fields-grid">
                    {/* Left: Fields Table */}
                    <div className="er-card er-card-grow">
                      <div className="er-card-header">
                        <h3>Fields for &quot;{activeEntity.name}&quot; ({activeEntity.fields.length})</h3>
                      </div>

                      {activeEntity.fields.length === 0 ? (
                        <div className="er-empty-state">No fields defined yet. Add fields using the form on the right.</div>
                      ) : (
                        <div className="er-table-wrapper">
                          <table className="er-table" data-testid="er-fields-table">
                            <thead>
                              <tr>
                                <th>Name</th>
                                <th>Type</th>
                                <th>Nullability</th>
                                <th>Key / Constraint</th>
                                <th>Mapped Column</th>
                                <th>Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {activeEntity.fields.map((f, idx) => (
                                <tr
                                  key={idx}
                                  className={editingFieldIndex === idx ? 'active-row' : ''}
                                  data-testid={`er-field-row-${f.name}`}
                                >
                                  <td>
                                    <strong>{f.name}</strong>
                                  </td>
                                  <td>
                                    <code>{f.type}</code>
                                  </td>
                                  <td>
                                    {f.optional ? (
                                      <span className="badge badge-nullable" data-testid={`er-field-nullable-${f.name}`}>
                                        Nullable (?)
                                      </span>
                                    ) : (
                                      <span className="badge badge-required" data-testid={`er-field-required-${f.name}`}>
                                        Required
                                      </span>
                                    )}
                                  </td>
                                  <td>
                                    {f.key ? (
                                      <span
                                        className={`badge badge-key badge-key-${f.key.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}
                                        data-testid={`er-field-key-${f.name}`}
                                      >
                                        <Key size={10} />
                                        {f.key}
                                      </span>
                                    ) : (
                                      <span className="er-none">-</span>
                                    )}
                                  </td>
                                  <td>
                                    {f.mappedName ? (
                                      <code data-testid={`er-field-mapped-${f.name}`}>{f.mappedName}</code>
                                    ) : (
                                      <span className="er-none">-</span>
                                    )}
                                  </td>
                                  <td className="er-actions-cell">
                                    <button
                                      type="button"
                                      className="btn btn-xs btn-outline"
                                      onClick={() => handleEditFieldClick(idx)}
                                      title={`Edit field ${f.name}`}
                                      data-testid={`er-edit-field-${f.name}`}
                                    >
                                      <Edit3 size={12} />
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-xs btn-outline-danger"
                                      onClick={() => handleDeleteField(idx)}
                                      disabled={readOnly}
                                      title={`Delete field ${f.name}`}
                                      data-testid={`er-delete-field-${f.name}`}
                                    >
                                      <Trash2 size={12} />
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* Composite Key Sub-section */}
                      <div className="er-composite-key-section" data-testid="er-composite-key-section">
                        <h4>Composite Key Editor</h4>
                        <p className="form-help">
                          Select multiple fields to define a composite primary key or composite unique key.
                        </p>
                        <div className="composite-fields-selector">
                          {activeEntity.fields.map(f => {
                            const isChecked = compositeKeyFields.includes(f.name);
                            return (
                              <label key={f.name} className="checkbox-chip">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={e => {
                                    if (e.target.checked) {
                                      setCompositeKeyFields(prev => [...prev, f.name]);
                                    } else {
                                      setCompositeKeyFields(prev => prev.filter(n => n !== f.name));
                                    }
                                  }}
                                  data-testid={`er-composite-field-checkbox-${f.name}`}
                                />
                                <span>{f.name}</span>
                              </label>
                            );
                          })}
                        </div>
                        <div className="composite-key-actions">
                          <select
                            className="form-control form-control-sm"
                            value={compositeKeyType}
                            onChange={e => setCompositeKeyType(e.target.value as any)}
                            data-testid="er-composite-key-type"
                          >
                            <option value="PK">Composite Primary Key (PK)</option>
                            <option value="UNIQUE">Composite Unique Key (UNIQUE)</option>
                          </select>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={handleApplyCompositeKey}
                            disabled={readOnly || compositeKeyFields.length === 0}
                            data-testid="er-apply-composite-key-btn"
                          >
                            <Key size={14} />
                            <span>Apply Composite Key</span>
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Right: Add / Edit Field Form */}
                    <div className="er-card er-card-form">
                      <div className="er-card-header">
                        <h3>{editingFieldIndex !== null ? 'Edit Field' : 'Add Field'}</h3>
                        {editingFieldIndex !== null && (
                          <button
                            type="button"
                            className="btn btn-xs btn-outline"
                            onClick={() => {
                              setEditingFieldIndex(null);
                              setFieldName('');
                              setFieldKey('');
                              setFieldMappedName('');
                            }}
                          >
                            Cancel
                          </button>
                        )}
                      </div>

                      <form onSubmit={handleSaveField} data-testid="er-field-form">
                        <div className="form-group">
                          <label>Field Name *</label>
                          <input
                            type="text"
                            className="form-control"
                            placeholder="e.g. id, email, status, userId"
                            value={fieldName}
                            onChange={e => setFieldName(e.target.value)}
                            required
                            data-testid="er-field-name-input"
                          />
                        </div>

                        <div className="form-group">
                          <label>Field Type *</label>
                          <div className="type-input-group">
                            <input
                              type="text"
                              className="form-control"
                              placeholder="Type name (e.g. Int, String, Role)"
                              value={fieldType}
                              onChange={e => setFieldType(e.target.value)}
                              required
                              data-testid="er-field-type-input"
                            />
                            <div className="type-chips">
                              {COMMON_FIELD_TYPES.map(t => (
                                <button
                                  type="button"
                                  key={t}
                                  className={`btn-type-chip ${fieldType === t ? 'active' : ''}`}
                                  onClick={() => setFieldType(t)}
                                >
                                  {t}
                                </button>
                              ))}
                              {enums.map(en => (
                                <button
                                  type="button"
                                  key={en.name}
                                  className={`btn-type-chip chip-enum ${fieldType === en.name ? 'active' : ''}`}
                                  onClick={() => setFieldType(en.name)}
                                  title={`Custom Enum: ${en.name}`}
                                >
                                  {en.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>

                        <div className="form-group checkbox-group">
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={fieldOptional}
                              onChange={e => setFieldOptional(e.target.checked)}
                              data-testid="er-field-optional-input"
                            />
                            <span>Nullable / Optional (?)</span>
                          </label>
                          <span className="form-help">Checked means the field can be null/optional.</span>
                        </div>

                        <div className="form-group">
                          <label>Key / Constraint</label>
                          <select
                            className="form-control"
                            value={fieldKey}
                            onChange={e => setFieldKey(e.target.value)}
                            data-testid="er-field-key-input"
                          >
                            <option value="">None (Standard Field)</option>
                            <option value="PK">Primary Key (PK)</option>
                            <option value="PK (composite)">Composite Primary Key</option>
                            <option value="UNIQUE">Unique Constraint (UNIQUE)</option>
                            <option value="UNIQUE (composite)">Composite Unique Constraint</option>
                            <option value="FK">Foreign Key (FK)</option>
                            <option value="RELATION">Relation Field</option>
                          </select>
                        </div>

                        <div className="form-group">
                          <label>Mapped Column Name</label>
                          <input
                            type="text"
                            className="form-control"
                            placeholder="e.g. user_id, is_active (@map)"
                            value={fieldMappedName}
                            onChange={e => setFieldMappedName(e.target.value)}
                            data-testid="er-field-mapped-input"
                          />
                          <span className="form-help">Database column name if different from field name.</span>
                        </div>

                        <button
                          type="submit"
                          className="btn btn-primary btn-sm btn-block"
                          disabled={readOnly || !fieldName.trim() || !fieldType.trim()}
                          data-testid="er-field-submit-btn"
                        >
                          <Check size={14} />
                          <span>{editingFieldIndex !== null ? 'Update Field' : 'Add Field'}</span>
                        </button>
                      </form>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* =====================================================================
            TAB 3: ENUMS
            ===================================================================== */}
        {activeTab === 'enums' && (
          <div className="er-tab-content" data-testid="er-enums-panel">
            <div className="er-section-grid">
              {/* Form: Add Enum */}
              <div className="er-card">
                <div className="er-card-header">
                  <h3>Add Enum</h3>
                </div>
                <form onSubmit={handleCreateEnum} data-testid="er-create-enum-form">
                  <div className="form-group">
                    <label>Enum Name *</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="e.g. Role, OrderStatus, Priority"
                      value={newEnumName}
                      onChange={e => setNewEnumName(e.target.value)}
                      required
                      data-testid="er-new-enum-name"
                    />
                  </div>

                  <div className="form-group">
                    <label>Parent Module / System</label>
                    <select
                      className="form-control"
                      value={newEnumParent}
                      onChange={e => setNewEnumParent(e.target.value)}
                      data-testid="er-new-enum-parent"
                    >
                      <option value="">None (Root ER Schema)</option>
                      {modules.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.kind})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Enum Members / Values</label>
                    <div className="enum-member-input-row">
                      <input
                        type="text"
                        className="form-control"
                        placeholder="e.g. ACTIVE, PENDING, CANCELLED"
                        value={newEnumMemberInput}
                        onChange={e => setNewEnumMemberInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddEnumMember();
                          }
                        }}
                        data-testid="er-new-enum-member-input"
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={handleAddEnumMember}
                        data-testid="er-add-enum-member-btn"
                      >
                        Add
                      </button>
                    </div>

                    <div className="enum-members-chips" data-testid="er-enum-members-chips">
                      {newEnumMembers.map(m => (
                        <span key={m} className="enum-chip">
                          {m}
                          <button
                            type="button"
                            onClick={() => handleRemoveEnumMember(m)}
                            className="btn-chip-remove"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      {newEnumMembers.length === 0 && (
                        <span className="er-none">No values added yet. Type value and click Add or press Enter.</span>
                      )}
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={readOnly || !newEnumName.trim() || newEnumMembers.length === 0}
                    data-testid="er-create-enum-submit"
                  >
                    <Plus size={14} />
                    <span>Create Enum</span>
                  </button>
                </form>
              </div>

              {/* List: Existing Enums */}
              <div className="er-card">
                <div className="er-card-header">
                  <h3>Defined Enums ({enums.length})</h3>
                </div>
                {enums.length === 0 ? (
                  <div className="er-empty-state">No enums defined yet. Create an enum on the left.</div>
                ) : (
                  <div className="er-table-wrapper">
                    <table className="er-table" data-testid="er-enums-table">
                      <thead>
                        <tr>
                          <th>Enum Name</th>
                          <th>Values / Members</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {enums.map(en => (
                          <tr key={en.id} data-testid={`er-enum-row-${en.name}`}>
                            <td>
                              <strong>{en.name}</strong>
                            </td>
                            <td>
                              <div className="enum-values-list">
                                {en.fields.map(f => (
                                  <span key={f.name} className="badge badge-enum-val">
                                    {f.name}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="er-actions-cell">
                              <button
                                type="button"
                                className="btn btn-xs btn-outline-danger"
                                onClick={() => handleDeleteEnum(en.id)}
                                disabled={readOnly}
                                title={`Delete enum ${en.name}`}
                                data-testid={`er-delete-enum-${en.id}`}
                              >
                                <Trash2 size={12} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* =====================================================================
            TAB 4: RELATIONSHIPS
            ===================================================================== */}
        {activeTab === 'relationships' && (
          <div className="er-tab-content" data-testid="er-relationships-panel">
            <div className="er-section-grid">
              {/* Form: Add Relationship */}
              <div className="er-card">
                <div className="er-card-header">
                  <h3>Define Entity Relationship</h3>
                </div>
                <form onSubmit={handleCreateRelationship} data-testid="er-create-relationship-form">
                  <div className="form-group">
                    <label>Source Entity *</label>
                    <select
                      className="form-control"
                      value={relSourceId}
                      onChange={e => setRelSourceId(e.target.value)}
                      required
                      data-testid="er-rel-source-select"
                    >
                      <option value="">Select source entity…</option>
                      {entities.map(e => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Target Entity *</label>
                    <select
                      className="form-control"
                      value={relTargetId}
                      onChange={e => setRelTargetId(e.target.value)}
                      required
                      data-testid="er-rel-target-select"
                    >
                      <option value="">Select target entity…</option>
                      {entities.map(e => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Relationship Cardinality *</label>
                    <select
                      className="form-control"
                      value={relCardinality}
                      onChange={e => setRelCardinality(e.target.value as CardinalityType)}
                      required
                      data-testid="er-rel-cardinality-select"
                    >
                      {CARDINALITY_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label} — {opt.description}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Field Associations / Foreign Keys</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="e.g. authorId, or orderId, itemId"
                      value={relForeignKeys}
                      onChange={e => setRelForeignKeys(e.target.value)}
                      data-testid="er-rel-foreign-keys"
                    />
                    <span className="form-help">Comma-separated foreign key field(s) associating the entities.</span>
                  </div>

                  <div className="form-group checkbox-group">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={relAutoMarkFk}
                        onChange={e => setRelAutoMarkFk(e.target.checked)}
                        data-testid="er-rel-auto-mark-fk"
                      />
                      <span>Mark field as Foreign Key (FK) on source entity</span>
                    </label>
                  </div>

                  <div className="form-group">
                    <label>Custom Label Override (Optional)</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder={`Default: ${formatRelationshipLabel(relCardinality, relForeignKeys ? relForeignKeys.split(',') : [])}`}
                      value={relCustomLabel}
                      onChange={e => setRelCustomLabel(e.target.value)}
                      data-testid="er-rel-label-override"
                    />
                  </div>

                  <div className="relationship-preview-box" data-testid="er-rel-preview-box">
                    <strong>Generated Label Preview:</strong>
                    <code>
                      {relCustomLabel || formatRelationshipLabel(relCardinality, relForeignKeys ? relForeignKeys.split(',') : [])}
                    </code>
                  </div>

                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={readOnly || !relSourceId || !relTargetId || relSourceId === relTargetId}
                    data-testid="er-create-relationship-submit"
                  >
                    <Link2 size={14} />
                    <span>Create Relationship</span>
                  </button>
                </form>
              </div>

              {/* List: Existing Relationships */}
              <div className="er-card">
                <div className="er-card-header">
                  <h3>Configured Relationships ({relationships.length})</h3>
                </div>
                {relationships.length === 0 ? (
                  <div className="er-empty-state">No entity relationships defined yet. Configure one on the left.</div>
                ) : (
                  <div className="er-table-wrapper">
                    <table className="er-table" data-testid="er-relationships-table">
                      <thead>
                        <tr>
                          <th>Source</th>
                          <th>Relationship / Cardinality</th>
                          <th>Target</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {relationships.map(rel => {
                          const src = currentGraph.nodes.find(n => n.id === rel.source);
                          const tgt = currentGraph.nodes.find(n => n.id === rel.target);
                          const parsed = parseRelationshipLabel(rel.label);
                          return (
                            <tr key={rel.id} data-testid={`er-rel-row-${rel.id}`}>
                              <td>
                                <strong>{src?.name || rel.source}</strong>
                              </td>
                              <td>
                                <span className="badge badge-cardinality" data-testid={`er-rel-cardinality-${rel.id}`}>
                                  {parsed.cardinality}
                                </span>
                                {parsed.foreignKeys.length > 0 && (
                                  <span className="er-rel-fks" data-testid={`er-rel-fks-${rel.id}`}>
                                    · {parsed.foreignKeys.join(', ')}
                                  </span>
                                )}
                              </td>
                              <td>
                                <strong>{tgt?.name || rel.target}</strong>
                              </td>
                              <td className="er-actions-cell">
                                <button
                                  type="button"
                                  className="btn btn-xs btn-outline-danger"
                                  onClick={() => handleDeleteRelationship(rel.id)}
                                  disabled={readOnly}
                                  title="Delete relationship"
                                  data-testid={`er-delete-rel-${rel.id}`}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  if (mode === 'modal') {
    return (
      <div className="er-modal-backdrop" data-testid="er-modal-backdrop">
        <div className="er-modal-dialog">{content}</div>
      </div>
    );
  }

  return content;
};
