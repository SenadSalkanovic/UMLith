import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  ErEditor,
  createEntityNode,
  updateEntityNode,
  removeEntityNode,
  addEntityField,
  updateEntityField,
  removeEntityField,
  setCompositeKey,
  createEnumNode,
  updateEnumNode,
  removeEnumNode,
  createEntityRelationship,
  updateEntityRelationship,
  removeEntityRelationship,
  formatRelationshipLabel,
  parseRelationshipLabel,
  getMappedTableName,
  DATABASE_UNVERIFIED_NOTICE,
  type EntityField,
} from '../../src/components/ErEditor';
import { App } from '../../src/App';
import { Header } from '../../src/components/Header';
import { Canvas } from '../../src/components/Canvas';
import { PropertyInspector } from '../../src/components/PropertyInspector';
import * as api from '../../src/api';
import { createServer } from '../../server/main';
import { ProjectStore } from '../../server/store';
import {
  emptyGraph,
  GraphSchema,
  validRelationship,
  type Project,
  type Graph,
  type ProgramNode,
  type ProgramEdge,
} from '../../shared/model';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function createBaseErGraph(): Graph {
  const nodes: ProgramNode[] = [
    {
      id: 'mod-data',
      kind: 'module',
      name: 'DataModule',
      description: 'Data layer container',
      provenance: 'human',
      policy: 'editable',
      contract: '',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/data.ts',
      fields: [],
    },
    {
      id: 'ent-user',
      kind: 'entity',
      name: 'User',
      parentId: 'mod-data',
      description: 'System user account · Database name: users',
      provenance: 'human',
      policy: 'editable',
      contract: '',
      requiredChecks: [],
      instructions: '',
      outputPath: 'prisma/schema.prisma',
      fields: [
        { name: 'id', type: 'Int', key: 'PK', optional: false },
        { name: 'email', type: 'String', key: 'UNIQUE', optional: false, mappedName: 'email_address' },
        { name: 'displayName', type: 'String', key: '', optional: true, mappedName: 'display_name' },
      ],
    },
    {
      id: 'enum-role',
      kind: 'enum',
      name: 'UserRole',
      parentId: 'mod-data',
      description: 'User access levels',
      provenance: 'human',
      policy: 'editable',
      contract: 'enum UserRole { ADMIN, MEMBER, GUEST }',
      requiredChecks: [],
      instructions: '',
      outputPath: 'prisma/schema.prisma',
      fields: [
        { name: 'ADMIN', type: 'enum', key: '', optional: false },
        { name: 'MEMBER', type: 'enum', key: '', optional: false },
        { name: 'GUEST', type: 'enum', key: '', optional: false },
      ],
    },
  ];

  return {
    schemaVersion: 1,
    nodes,
    edges: [],
    requirements: [],
  };
}

describe('T021 — Edit entities, fields, keys, and relationships', () => {
  // =========================================================================
  // Concrete Validation Scenario 1: Model one-to-many and many-to-many relations
  // =========================================================================
  describe('Concrete Scenario 1: Model one-to-many and many-to-many relations', () => {
    it('models a one-to-many relation with foreign key field association and validates round-trip', () => {
      let graph = emptyGraph();

      // Step 1: Create User entity
      const { graph: g1, node: userNode } = createEntityNode(graph, {
        name: 'User',
        description: 'User account',
        fields: [
          { name: 'id', type: 'Int', key: 'PK', optional: false },
          { name: 'username', type: 'String', key: 'UNIQUE', optional: false },
        ],
      });
      graph = g1;

      // Step 2: Create Post entity with foreign key authorId
      const { graph: g2, node: postNode } = createEntityNode(graph, {
        name: 'Post',
        description: 'Blog post created by user',
        fields: [
          { name: 'id', type: 'Int', key: 'PK', optional: false },
          { name: 'title', type: 'String', key: '', optional: false },
          { name: 'content', type: 'String', key: '', optional: true },
          { name: 'authorId', type: 'Int', key: 'FK', optional: false, mappedName: 'author_id' },
        ],
      });
      graph = g2;

      // Step 3: Connect User to Post with one-to-many cardinality and authorId field association
      const { graph: g3, edge: oneToManyEdge } = createEntityRelationship(graph, {
        sourceEntityId: userNode.id,
        targetEntityId: postNode.id,
        cardinality: 'one → many',
        foreignKeyFields: ['authorId'],
      });
      graph = g3;

      expect(oneToManyEdge.source).toBe(userNode.id);
      expect(oneToManyEdge.target).toBe(postNode.id);
      expect(oneToManyEdge.kind).toBe('relates-to');
      expect(oneToManyEdge.label).toBe('one → many · authorId');

      // Validate parsed relationship details
      const parsed = parseRelationshipLabel(oneToManyEdge.label);
      expect(parsed.cardinality).toBe('one → many');
      expect(parsed.foreignKeys).toEqual(['authorId']);

      // Ensure graph validates against shared schema
      const parseResult = GraphSchema.safeParse(graph);
      expect(parseResult.success).toBe(true);
    });

    it('models direct many-to-many relations and join-table many-to-many relations with composite keys', () => {
      let graph = emptyGraph();

      // Step 1: Create Post entity
      const { graph: g1, node: post } = createEntityNode(graph, {
        name: 'Post',
        fields: [{ name: 'id', type: 'Int', key: 'PK', optional: false }],
      });

      // Step 2: Create Tag entity
      const { graph: g2, node: tag } = createEntityNode(g1, {
        name: 'Tag',
        fields: [
          { name: 'id', type: 'Int', key: 'PK', optional: false },
          { name: 'name', type: 'String', key: 'UNIQUE', optional: false },
        ],
      });

      // Step 3: Direct Many-to-Many relation between Post and Tag
      const { graph: g3, edge: directM2mEdge } = createEntityRelationship(g2, {
        sourceEntityId: post.id,
        targetEntityId: tag.id,
        cardinality: 'many → many',
      });

      expect(directM2mEdge.label).toBe('many → many');
      expect(parseRelationshipLabel(directM2mEdge.label).cardinality).toBe('many → many');

      // Step 4: Explicit join-entity many-to-many model (PostTag)
      const { graph: g4, node: postTag } = createEntityNode(g3, {
        name: 'PostTag',
        mappedTableName: 'post_tags',
        fields: [
          { name: 'postId', type: 'Int', key: 'PK (composite)', optional: false, mappedName: 'post_id' },
          { name: 'tagId', type: 'Int', key: 'PK (composite)', optional: false, mappedName: 'tag_id' },
          { name: 'assignedAt', type: 'DateTime', key: '', optional: false, mappedName: 'assigned_at' },
        ],
      });

      // Connect Post -> PostTag (1:N) and Tag -> PostTag (1:N)
      const { graph: g5, edge: edge1 } = createEntityRelationship(g4, {
        sourceEntityId: post.id,
        targetEntityId: postTag.id,
        cardinality: 'one → many',
        foreignKeyFields: ['postId'],
      });
      const { graph: g6, edge: edge2 } = createEntityRelationship(g5, {
        sourceEntityId: tag.id,
        targetEntityId: postTag.id,
        cardinality: 'one → many',
        foreignKeyFields: ['tagId'],
      });

      graph = g6;
      expect(edge1.label).toBe('one → many · postId');
      expect(edge2.label).toBe('one → many · tagId');
      expect(graph.nodes).toHaveLength(3);
      expect(graph.edges).toHaveLength(3);

      const validation = GraphSchema.safeParse(graph);
      expect(validation.success).toBe(true);
    });

    it('persists modeled relations through the server and updates specification revision', async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 't021-scenario1-'));
      const store = new ProjectStore(dataDir);
      const server = await createServer({ store, host: '127.0.0.1' });
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address() as any;
      const baseUrl = `http://127.0.0.1:${address.port}/api`;

      try {
        const proj = await api.createBlankProject({ name: 'Ecommerce ER', target: 'Web application' }, baseUrl);
        expect(proj.specRevision).toBe(0);

        let g = proj.specification;
        const { graph: g1, node: customer } = createEntityNode(g, {
          name: 'Customer',
          fields: [{ name: 'id', type: 'Int', key: 'PK', optional: false }],
        });
        const { graph: g2, node: order } = createEntityNode(g1, {
          name: 'Order',
          fields: [
            { name: 'id', type: 'Int', key: 'PK', optional: false },
            { name: 'customerId', type: 'Int', key: 'FK', optional: false },
          ],
        });
        const { graph: g3, edge } = createEntityRelationship(g2, {
          sourceEntityId: customer.id,
          targetEntityId: order.id,
          cardinality: 'one → many',
          foreignKeyFields: ['customerId'],
        });

        const updated = await api.updateSpecification(proj.id, proj.specRevision, g3, baseUrl);
        expect(updated.specRevision).toBe(1);
        expect(updated.specification.nodes).toHaveLength(2);
        expect(updated.specification.edges).toHaveLength(1);

        const fetched = await api.getSpecification(proj.id, baseUrl);
        expect(fetched.nodes.map(n => n.name)).toContain('Customer');
        expect(fetched.nodes.map(n => n.name)).toContain('Order');
        expect(fetched.edges[0].label).toBe('one → many · customerId');
      } finally {
        await server.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // Concrete Validation Scenario 2: Edit a composite key and a mapped database name
  // =========================================================================
  describe('Concrete Scenario 2: Edit a composite key and a mapped database name', () => {
    it('edits a composite primary key across multiple fields and updates mapped database names', () => {
      let graph = emptyGraph();

      // Step 1: Create OrderItem entity
      const { graph: g1, node: ent } = createEntityNode(graph, {
        name: 'OrderItem',
        mappedTableName: 'tbl_order_items',
        description: 'Order line items',
        fields: [
          { name: 'orderId', type: 'Int', optional: false, mappedName: 'order_id' },
          { name: 'itemId', type: 'Int', optional: false, mappedName: 'item_id' },
          { name: 'quantity', type: 'Int', optional: false },
          { name: 'unitPrice', type: 'Decimal', optional: false, mappedName: 'unit_price' },
        ],
      });
      graph = g1;

      expect(getMappedTableName(ent)).toBe('tbl_order_items');
      expect(ent.fields[0].mappedName).toBe('order_id');
      expect(ent.fields[1].mappedName).toBe('item_id');

      // Step 2: Set composite primary key on [orderId, itemId]
      const { graph: g2, node: withCompositeKey } = setCompositeKey(
        graph,
        ent.id,
        ['orderId', 'itemId'],
        'PK'
      );
      graph = g2;

      const orderIdField = withCompositeKey.fields.find(f => f.name === 'orderId');
      const itemIdField = withCompositeKey.fields.find(f => f.name === 'itemId');
      const qtyField = withCompositeKey.fields.find(f => f.name === 'quantity');

      expect(orderIdField?.key).toBe('PK (composite)');
      expect(itemIdField?.key).toBe('PK (composite)');
      expect(qtyField?.key).toBe('');

      // Step 3: Edit mapped database column name for itemId to 'sku_number'
      const { graph: g3, node: withUpdatedField } = updateEntityField(
        graph,
        ent.id,
        'itemId',
        { mappedName: 'sku_number' }
      );
      graph = g3;

      const updatedItemId = withUpdatedField.fields.find(f => f.name === 'itemId');
      expect(updatedItemId?.mappedName).toBe('sku_number');
      expect(updatedItemId?.key).toBe('PK (composite)');

      // Step 4: Edit mapped database table name from 'tbl_order_items' to 'order_items_v2'
      const { graph: g4, node: withUpdatedTable } = updateEntityNode(
        graph,
        ent.id,
        { mappedTableName: 'order_items_v2' }
      );
      graph = g4;

      expect(getMappedTableName(withUpdatedTable)).toBe('order_items_v2');
      expect(withUpdatedTable.description).toContain('Database name: order_items_v2');

      // Step 5: Shared schema validation
      const validation = GraphSchema.safeParse(graph);
      expect(validation.success).toBe(true);
    });

    it('round-trips composite unique keys and column mappings to server storage', async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 't021-scenario2-'));
      const store = new ProjectStore(dataDir);
      const server = await createServer({ store, host: '127.0.0.1' });
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address() as any;
      const baseUrl = `http://127.0.0.1:${address.port}/api`;

      try {
        const proj = await api.createBlankProject({ name: 'Composite Keys Project', target: 'Web application' }, baseUrl);

        let g = proj.specification;
        const { graph: g1, node: member } = createEntityNode(g, {
          name: 'TeamMember',
          mappedTableName: 'team_members',
          fields: [
            { name: 'tenantId', type: 'String', optional: false, mappedName: 'tenant_id' },
            { name: 'email', type: 'String', optional: false, mappedName: 'user_email' },
            { name: 'role', type: 'String', optional: false },
          ],
        });

        const { graph: g2 } = setCompositeKey(g1, member.id, ['tenantId', 'email'], 'UNIQUE');

        const updated = await api.updateSpecification(proj.id, proj.specRevision, g2, baseUrl);
        expect(updated.specRevision).toBe(1);

        const fetched = await api.getSpecification(proj.id, baseUrl);
        const fetchedMember = fetched.nodes.find(n => n.name === 'TeamMember')!;
        expect(getMappedTableName(fetchedMember)).toBe('team_members');

        const tenantField = fetchedMember.fields.find(f => f.name === 'tenantId')!;
        const emailField = fetchedMember.fields.find(f => f.name === 'email')!;

        expect(tenantField.key).toBe('UNIQUE (composite)');
        expect(tenantField.mappedName).toBe('tenant_id');
        expect(emailField.key).toBe('UNIQUE (composite)');
        expect(emailField.mappedName).toBe('user_email');
      } finally {
        await server.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // Acceptance Criterion 1: ER edits round-trip through shared validation
  // =========================================================================
  describe('Acceptance Criterion 1: ER edits round-trip through shared validation', () => {
    it('validates adding, updating, and removing entities and field properties', () => {
      let graph = emptyGraph();

      // Create entity
      const { graph: g1, node: ent } = createEntityNode(graph, {
        name: 'Account',
        fields: [{ name: 'id', type: 'String', key: 'PK', optional: false }],
      });
      graph = g1;
      expect(GraphSchema.safeParse(graph).success).toBe(true);

      // Add fields with nullability and column mappings
      const { graph: g2 } = addEntityField(graph, ent.id, {
        name: 'balance',
        type: 'Decimal',
        optional: false,
        mappedName: 'account_balance',
      });
      const { graph: g3 } = addEntityField(g2, ent.id, {
        name: 'notes',
        type: 'String',
        optional: true,
      });
      graph = g3;

      const accNode = graph.nodes.find(n => n.id === ent.id)!;
      expect(accNode.fields).toHaveLength(3);
      expect(accNode.fields[1].optional).toBe(false);
      expect(accNode.fields[1].mappedName).toBe('account_balance');
      expect(accNode.fields[2].optional).toBe(true);
      expect(GraphSchema.safeParse(graph).success).toBe(true);

      // Update field
      const { graph: g4 } = updateEntityField(graph, ent.id, 'notes', {
        name: 'description',
        type: 'String',
        optional: true,
      });
      graph = g4;
      const updatedNode = graph.nodes.find(n => n.id === ent.id)!;
      expect(updatedNode.fields.some(f => f.name === 'description')).toBe(true);
      expect(updatedNode.fields.some(f => f.name === 'notes')).toBe(false);

      // Remove field
      const { graph: g5, removedField } = removeEntityField(graph, ent.id, 'description');
      graph = g5;
      expect(removedField.name).toBe('description');
      expect(graph.nodes.find(n => n.id === ent.id)!.fields).toHaveLength(2);
      expect(GraphSchema.safeParse(graph).success).toBe(true);
    });

    it('validates creating and updating enums and enum member lists', () => {
      let graph = emptyGraph();

      // Create enum
      const { graph: g1, node: enumNode } = createEnumNode(graph, {
        name: 'OrderStatus',
        members: ['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED'],
      });
      graph = g1;

      expect(enumNode.kind).toBe('enum');
      expect(enumNode.fields).toHaveLength(4);
      expect(enumNode.fields.map(f => f.name)).toEqual(['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED']);
      expect(GraphSchema.safeParse(graph).success).toBe(true);

      // Update enum members
      const { graph: g2, node: updatedEnum } = updateEnumNode(graph, enumNode.id, {
        members: ['PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED'],
      });
      graph = g2;

      expect(updatedEnum.fields.map(f => f.name)).toContain('CANCELLED');
      expect(GraphSchema.safeParse(graph).success).toBe(true);

      // Remove enum
      const { graph: g3, removedNode } = removeEnumNode(graph, enumNode.id);
      graph = g3;
      expect(removedNode.name).toBe('OrderStatus');
      expect(graph.nodes).toHaveLength(0);
      expect(GraphSchema.safeParse(graph).success).toBe(true);
    });

    it('rejects invalid entity or relationship configurations with actionable errors', () => {
      const graph = emptyGraph();

      // Blank entity name
      expect(() => createEntityNode(graph, { name: '' })).toThrow('Entity name must not be blank');

      // Non-existent parent
      expect(() => createEntityNode(graph, { name: 'BadParent', parentId: 'missing-parent' })).toThrow('Parent node does not exist');

      // Duplicate field name
      const { graph: g1, node } = createEntityNode(graph, {
        name: 'DuplicateFields',
        fields: [{ name: 'code', type: 'String' }],
      });
      expect(() => addEntityField(g1, node.id, { name: 'code', type: 'Int' })).toThrow('already exists on entity');

      // Relationship between non-entities
      const { graph: g2, node: notEntity } = createEnumNode(g1, { name: 'TestEnum', members: ['A'] });
      expect(() => createEntityRelationship(g2, {
        sourceEntityId: node.id,
        targetEntityId: notEntity.id,
        cardinality: 'one → many',
      })).toThrow('Target must be an entity');
    });
  });

  // =========================================================================
  // Acceptance Criterion 2: Relationships preserve key/mapping detail
  // =========================================================================
  describe('Acceptance Criterion 2: Relationships preserve key/mapping detail', () => {
    it('preserves composite foreign key field associations and mapped names in relationship labels and entities', () => {
      let graph = emptyGraph();

      const { graph: g1, node: tenant } = createEntityNode(graph, {
        name: 'Tenant',
        fields: [{ name: 'tenantId', type: 'String', key: 'PK', mappedName: 'tenant_id' }],
      });
      const { graph: g2, node: user } = createEntityNode(g1, {
        name: 'TenantUser',
        fields: [
          { name: 'id', type: 'String', key: 'PK' },
          { name: 'tenantId', type: 'String', key: 'FK', mappedName: 'tenant_id' },
          { name: 'departmentId', type: 'String', key: 'FK', mappedName: 'dept_id' },
        ],
      });

      // Relationship with composite foreign keys
      const { graph: g3, edge } = createEntityRelationship(g2, {
        sourceEntityId: tenant.id,
        targetEntityId: user.id,
        cardinality: 'one → many',
        foreignKeyFields: ['tenantId', 'departmentId'],
      });
      graph = g3;

      expect(edge.label).toBe('one → many · tenantId, departmentId');

      const parsed = parseRelationshipLabel(edge.label);
      expect(parsed.cardinality).toBe('one → many');
      expect(parsed.foreignKeys).toEqual(['tenantId', 'departmentId']);

      // Updating relationship preserves foreign keys
      const { graph: g4, edge: updatedEdge } = updateEntityRelationship(graph, edge.id, {
        cardinality: 'one → zero or one',
      });
      expect(updatedEdge.label).toBe('one → zero or one · tenantId, departmentId');
      expect(GraphSchema.safeParse(g4).success).toBe(true);
    });

    it('cascades deletion of entity relationships while preserving requirements', () => {
      let graph = emptyGraph();
      const { graph: g1, node: e1 } = createEntityNode(graph, { name: 'E1' });
      const { graph: g2, node: e2 } = createEntityNode(g1, { name: 'E2' });
      const { graph: g3, edge: rel } = createEntityRelationship(g2, {
        sourceEntityId: e1.id,
        targetEntityId: e2.id,
        cardinality: 'one → many',
      });

      const reqWithRel = {
        id: 'req-schema-link',
        text: 'Schema relationship requirement',
        nodeIds: [e1.id, e2.id],
        edgeIds: [rel.id],
        constraints: [],
        scenarios: [],
      };

      graph = { ...g3, requirements: [reqWithRel] };

      const { graph: g4, removedEdge, preservedRequirements } = removeEntityRelationship(graph, rel.id);
      expect(removedEdge.id).toBe(rel.id);
      expect(g4.edges).toHaveLength(0);
      expect(g4.requirements).toHaveLength(1);
      expect(g4.requirements[0].edgeIds).not.toContain(rel.id);
      expect(g4.requirements[0].nodeIds).toContain(e1.id);
      expect(GraphSchema.safeParse(g4).success).toBe(true);
    });
  });

  // =========================================================================
  // Acceptance Criterion 3: The view never claims a live database was checked
  // =========================================================================
  describe('Acceptance Criterion 3: The view never claims a live database was checked', () => {
    it('renders the explicit database unverified disclaimer notice prominently in ErEditor', () => {
      const graph = createBaseErGraph();

      const html = renderToString(
        <ErEditor
          graph={graph}
          mode="inline"
          initialTab="entities"
        />
      );

      // Verify explicit disclaimer is rendered
      expect(html).toContain('data-testid="er-database-unverified-notice"');
      expect(html).toContain('Database Unverified');
      expect(html).toContain('Schema Definitions Only');
      expect(html).toContain('ER diagrams describe schema definitions and database state is unverified.');
      expect(html).toContain('Verifying an actual database requires a later, explicit introspection connection.');
      expect(html).toContain('Live database was not checked.');

      // Verify that NO claim of live database connection or verification exists
      expect(html).not.toContain('Database verified');
      expect(html).not.toContain('Connected to live database');
      expect(html).not.toContain('Live database verified');
      expect(html).not.toContain('Database state checked');
    });

    it('consistently displays the unverified notice across all editor tabs', () => {
      const graph = createBaseErGraph();
      const tabs = ['entities', 'fields', 'enums', 'relationships'] as const;

      for (const tab of tabs) {
        const html = renderToString(
          <ErEditor
            graph={graph}
            mode="inline"
            initialTab={tab}
          />
        );

        expect(html).toContain('data-testid="er-database-unverified-notice"');
        expect(html).toContain('data-testid="db-unverified-tag"');
        expect(html).toContain(DATABASE_UNVERIFIED_NOTICE);
        expect(html).not.toContain('Live database connected');
      }
    });
  });

  // =========================================================================
  // UI & Application Integration Tests
  // =========================================================================
  describe('UI & Workspace Integration', () => {
    it('renders Entities tab with entity creation form and entities table', () => {
      const graph = createBaseErGraph();
      const html = renderToString(<ErEditor graph={graph} initialTab="entities" mode="inline" />);

      expect(html).toContain('data-testid="er-entities-panel"');
      expect(html).toContain('data-testid="er-create-entity-form"');
      expect(html).toContain('data-testid="er-new-entity-name"');
      expect(html).toContain('data-testid="er-new-entity-mapped-table"');
      expect(html).toContain('data-testid="er-entities-table"');
      expect(html).toContain('User');
      expect(html).toContain('users');
    });

    it('renders Fields & Keys tab with entity selector, fields table, and composite key builder', () => {
      const graph = createBaseErGraph();
      const html = renderToString(<ErEditor graph={graph} initialTab="fields" mode="inline" selectedNodeId="ent-user" />);

      expect(html).toContain('data-testid="er-fields-panel"');
      expect(html).toContain('data-testid="er-entity-select"');
      expect(html).toContain('data-testid="er-active-entity-mapped-table"');
      expect(html).toContain('data-testid="er-fields-table"');
      expect(html).toContain('data-testid="er-field-row-email"');
      expect(html).toContain('data-testid="er-field-key-email"');
      expect(html).toContain('data-testid="er-field-mapped-email"');
      expect(html).toContain('data-testid="er-composite-key-section"');
      expect(html).toContain('data-testid="er-apply-composite-key-btn"');
    });

    it('renders Enums tab with enum creation form and member list', () => {
      const graph = createBaseErGraph();
      const html = renderToString(<ErEditor graph={graph} initialTab="enums" mode="inline" />);

      expect(html).toContain('data-testid="er-enums-panel"');
      expect(html).toContain('data-testid="er-create-enum-form"');
      expect(html).toContain('data-testid="er-new-enum-name"');
      expect(html).toContain('data-testid="er-enums-table"');
      expect(html).toContain('UserRole');
      expect(html).toContain('ADMIN');
      expect(html).toContain('MEMBER');
      expect(html).toContain('GUEST');
    });

    it('renders Relationships tab with entity selector, cardinality dropdown, and preview box', () => {
      const graph = createBaseErGraph();
      const html = renderToString(<ErEditor graph={graph} initialTab="relationships" mode="inline" />);

      expect(html).toContain('data-testid="er-relationships-panel"');
      expect(html).toContain('data-testid="er-create-relationship-form"');
      expect(html).toContain('data-testid="er-rel-source-select"');
      expect(html).toContain('data-testid="er-rel-target-select"');
      expect(html).toContain('data-testid="er-rel-cardinality-select"');
      expect(html).toContain('data-testid="er-rel-foreign-keys"');
      expect(html).toContain('data-testid="er-rel-preview-box"');
    });

    it('integrates ER Editor trigger in Header, Canvas, and PropertyInspector', () => {
      const project: Project = {
        id: 'p-er-integrated',
        name: 'ER Workspace App',
        description: 'Complete workspace test with ER',
        target: 'Web application',
        root: '/app/er',
        managed: true,
        createdAt: new Date().toISOString(),
        specRevision: 0,
        specification: createBaseErGraph(),
        layout: {},
        checks: {},
      };

      // Header button
      const headerHtml = renderToString(
        <Header
          project={project}
          syncStatus="current"
          viewState={{
            selectedId: null,
            selectedType: null,
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onTogglePanel={() => {}}
          onOpenNewProject={() => {}}
          onOpenProjectPicker={() => {}}
          onOpenArchitectureEditor={() => {}}
          onOpenErEditor={() => {}}
        />
      );
      expect(headerHtml).toContain('data-testid="header-open-er"');

      // Canvas button
      const canvasHtml = renderToString(
        <Canvas
          graph={project.specification}
          layout={{}}
          viewState={{
            selectedId: null,
            selectedType: null,
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onSelectNode={() => {}}
          onScopeChange={() => {}}
          onOpenArchitectureEditor={() => {}}
          onOpenErEditor={() => {}}
        />
      );
      expect(canvasHtml).toContain('data-testid="canvas-open-er-btn"');

      // PropertyInspector button for entity
      const inspectorHtml = renderToString(
        <PropertyInspector
          project={project}
          graph={project.specification}
          viewState={{
            selectedId: 'ent-user',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onClearSelection={() => {}}
          onDeleteNode={() => {}}
          onEditNode={() => {}}
          onEditErNode={() => {}}
        />
      );
      expect(inspectorHtml).toContain('data-testid="inspector-edit-er-node"');
    });

    it('renders full App shell with ErEditor modal integration', () => {
      const project: Project = {
        id: 'p-app-er',
        name: 'Full App ER Schema',
        description: 'Shell test',
        target: 'Desktop application',
        root: '/app/er',
        managed: true,
        createdAt: new Date().toISOString(),
        specRevision: 0,
        specification: createBaseErGraph(),
        layout: {},
        checks: {},
      };

      const appHtml = renderToString(<App initialProject={project} autoLoad={false} />);
      expect(appHtml).toContain('data-testid="workspace-shell"');
      expect(appHtml).toContain('data-testid="header-open-er"');
      expect(appHtml).toContain('data-testid="canvas-open-er-btn"');
    });
  });
});
