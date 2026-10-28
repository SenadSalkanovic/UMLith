import { translate, type Locale } from './i18n.ts';
import type { Edge, Node } from '@xyflow/react';

export const kinds = {
  component: 'kindComponent', class: 'kindClass', interface: 'kindInterface', entity: 'kindEntity', enum: 'kindEnum', note: 'kindNote',
  start: 'kindStart', action: 'kindAction', decision: 'kindDecision', fork: 'kindFork', join: 'kindJoin', end: 'kindEnd', frame: 'comment',
} as const;
export type Kind = keyof typeof kinds;
export type Mode = 'architecture' | 'er' | 'activity';
export type ElementData = { label: string; kind: Kind; body: string; group: string; stereotype: string; description: string };
export type DiagramNode = Node<ElementData, 'uml'>;
export const relations = { '-->': 'relationDirected', '..>': 'relationDependency', '--': 'relationAssociation', '*--': 'relationComposition', 'o--': 'relationAggregation', '--|>': 'relationInheritance', '..|>': 'relationRealization' } as const;
export type Relation = keyof typeof relations;
export type LinkData = { relation: Relation; label: string; sourceCardinality: string; targetCardinality: string };
export type DiagramEdge = Edge<LinkData, 'uml'>;
export type Diagram = { id: Mode; name: string; nodes: DiagramNode[]; edges: DiagramEdge[] };
export type Project = { version: 1; name: string; goal: string; diagrams: Diagram[] };
export const modes = { architecture: 'modeArchitecture', er: 'modeEr', activity: 'modeActivity' } as const;
export const palette: Record<Mode, Kind[]> = {
  architecture: ['component', 'class', 'interface', 'entity', 'enum', 'note', 'frame'],
  er: ['entity', 'enum', 'note', 'frame'], activity: ['start', 'action', 'decision', 'fork', 'join', 'end', 'frame'],
};
export function node(id: string, kind: Kind, label: string, x: number, y: number, body = '', group = ''): DiagramNode {
  const created: DiagramNode = { id, type: 'uml', position: { x, y }, data: { kind, label, body, group, stereotype: '', description: '' } };
  if (kind === 'frame') Object.assign(created, { width: 600, height: 360, zIndex: -1, dragHandle: '.comment-frame-heading', connectable: false });
  return created;
}
export function edge(source: string, target: string, label = '', relation: Relation = '-->', sourceCardinality = '', targetCardinality = ''): DiagramEdge {
  return { id: `${source}-${target}`, source, target, type: 'uml', data: { label, relation, sourceCardinality, targetCardinality } };
}
export function initialProject(locale: Locale = 'sl'): Project {
  const t = translate.bind(null, locale);
  return { version: 1, name: t('exampleName'), goal: t('exampleGoal'), diagrams: [
    { id: 'architecture', name: t('exampleArchitecture'), nodes: [
      node('controller', 'class', 'OrderController', 60, 210, '+ createOrder(dto): Order\n+ acceptOrder(id): Order\n+ rejectOrder(id, reason): Order', 'API'),
      node('service', 'class', 'OrderService', 430, 80, '+ receiveOrder(id): Order\n+ acceptOrder(id): Order\n+ closeOrder(id): Order\n- calculateTotals(order)', 'Service'),
      node('workflow', 'class', 'WorkflowCoordinator', 430, 360, '+ processAcceptedOrder(id)\n+ checkCompletion(id): boolean', 'Service'),
      node('invoice', 'class', 'InvoiceService', 800, 300, '+ sendInvoice(orderId): Invoice\n+ acceptPayment(id, dto): Payment', 'Service'),
      node('shipping', 'class', 'ShipmentService', 800, 530, '+ shipOrder(orderId): Shipment\n+ markDelivered(id): Shipment', 'Service'),
      node('repository', 'interface', 'OrderRepository', 800, 30, '+ findById(id): Optional<Order>\n+ save(order): Order', 'Repository'),
      node('order', 'entity', 'Order', 1170, 70, '- orderId: long <<PK>>\n- status: OrderStatusCode\n- grandTotal: BigDecimal\n--\n+ isReadyToClose(): boolean', 'Entity'),
    ], edges: [edge('controller', 'service', '', '..>'), edge('controller', 'workflow', '', '..>'), edge('service', 'repository', '', '..>'), edge('repository', 'order', '', '..>'), edge('workflow', 'invoice', t('examplePayment'), '..>'), edge('workflow', 'shipping', t('exampleShipping'), '..>'), edge('workflow', 'service', t('exampleClosing'), '..>')] },
    { id: 'er', name: t('exampleEr'), nodes: [
      node('customer', 'entity', 'Customer', 40, 200, '* customerId: long <<PK>>\n--\nfirstName: String\nlastName: String\nemail: String'),
      node('order', 'entity', 'Order', 400, 80, '* orderId: long <<PK>>\n* customerId: long <<FK>>\n--\nstatus: OrderStatusCode\ngrandTotal: BigDecimal\ncreatedAt: Instant'),
      node('item', 'entity', 'OrderItem', 400, 440, '* orderItemId: long <<PK>>\n* orderId: long <<FK>>\n* productId: long <<FK>>\n--\nquantity: int\nunitPrice: BigDecimal'),
      node('invoice', 'entity', 'Invoice', 790, 80, '* invoiceId: long <<PK>>\n* orderId: long <<FK>>\n--\ninvoiceNumber: String\ngrossAmount: BigDecimal'),
      node('product', 'entity', 'Product', 790, 440, '* productId: long <<PK>>\n--\nsku: String\nname: String\nprice: BigDecimal'),
      node('payment', 'entity', 'Payment', 1170, 80, '* paymentId: long <<PK>>\n* invoiceId: long <<FK>>\n--\namount: BigDecimal\npaidAt: Instant'),
    ], edges: [edge('customer', 'order', t('exampleOrders'), '--', '1', '0..*'), edge('order', 'item', t('exampleItems'), '*--', '1', '1..*'), edge('product', 'item', '', '--', '1', '0..*'), edge('order', 'invoice', '', '--', '1', '0..1'), edge('invoice', 'payment', '', '--', '1', '0..*')] },
    { id: 'activity', name: t('exampleActivity'), nodes: [
      node('start', 'start', t('kindStart'), 20, 200), node('receive', 'action', t('exampleReceive'), 120, 175),
      node('decision', 'decision', t('exampleDecision'), 400, 165), node('fill', 'action', t('exampleFill'), 670, 175),
      node('fork', 'fork', t('exampleParallel'), 950, 170), node('invoice', 'action', t('exampleInvoice'), 1080, 35),
      node('pay', 'action', t('examplePay'), 1370, 35), node('ship', 'action', t('exampleShip'), 1230, 320),
      node('join', 'join', t('exampleJoined'), 1670, 170), node('close', 'action', t('exampleClose'), 1800, 175),
      node('end', 'end', t('kindEnd'), 2100, 200),
    ], edges: [edge('start', 'receive'), edge('receive', 'decision'), edge('decision', 'fill', t('exampleAccepted')), edge('decision', 'close', t('exampleRejected')), edge('fill', 'fork'), edge('fork', 'invoice'), edge('invoice', 'pay'), edge('fork', 'ship'), edge('pay', 'join'), edge('ship', 'join'), edge('join', 'close'), edge('close', 'end')] },
  ] };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const textField = (v: unknown) => typeof v === 'string' && v.length <= 20000;
export function parseProject(value: unknown, locale: Locale = 'sl'): Project {
  const t = translate.bind(null, locale);
  if (!isRecord(value) || value.version !== 1 || !textField(value.name) || !textField(value.goal) || !Array.isArray(value.diagrams) || value.diagrams.length !== 3) throw new Error(t('invalidProject'));
  const seenModes = new Set();
  for (const d of value.diagrams) {
    if (!isRecord(d) || typeof d.id !== 'string' || !Object.hasOwn(modes, d.id) || seenModes.has(d.id) || !textField(d.name) || !Array.isArray(d.nodes) || !Array.isArray(d.edges) || d.nodes.length > 500 || d.edges.length > 2000) throw new Error(t('invalidDiagram'));
    seenModes.add(d.id);
    const ids = new Set();
    for (const n of d.nodes) {
      if (!isRecord(n) || typeof n.id !== 'string' || !/^[\w-]{1,100}$/.test(n.id) || ids.has(n.id) || n.type !== 'uml' || !isRecord(n.position) || !Number.isFinite(n.position.x) || !Number.isFinite(n.position.y) || !isRecord(n.data) || typeof n.data.kind !== 'string' || !palette[d.id as Mode].includes(n.data.kind as Kind) || !['label', 'body', 'group', 'stereotype', 'description'].every(k => textField((n.data as Record<string, unknown>)[k]))) throw new Error(t('invalidElement'));
      if (n.data.kind === 'frame' && ((n.width !== undefined && (typeof n.width !== 'number' || !Number.isFinite(n.width) || n.width < 280 || n.width > 10000)) || (n.height !== undefined && (typeof n.height !== 'number' || !Number.isFinite(n.height) || n.height < 160 || n.height > 10000)))) throw new Error(t('invalidFrameSize'));
      ids.add(n.id);
    }
    const edgeIds = new Set();
    const frameIds = new Set(d.nodes.filter(n => n.data.kind === 'frame').map(n => n.id));
    for (const e of d.edges) {
      if (!isRecord(e) || typeof e.id !== 'string' || !/^[\w-]{1,220}$/.test(e.id) || edgeIds.has(e.id) || !ids.has(e.source) || !ids.has(e.target) || !isRecord(e.data) || typeof e.data.relation !== 'string' || !Object.hasOwn(relations, e.data.relation) || !['label', 'sourceCardinality', 'targetCardinality'].every(k => textField((e.data as Record<string, unknown>)[k]))) throw new Error(t('invalidConnection'));
      edgeIds.add(e.id);
      if (frameIds.has(e.source) || frameIds.has(e.target)) throw new Error(t('frameConnection'));
    }
  }
  // Keep only our fields: imported React Flow internals and HTML attributes are not project data.
  return {
    version: 1, name: value.name as string, goal: value.goal as string,
    diagrams: (value.diagrams as Diagram[]).map(d => ({
      id: d.id, name: d.name,
      nodes: d.nodes.map(n => {
        const clean = node(n.id, n.data.kind, n.data.label, n.position.x, n.position.y, n.data.body, n.data.group);
        clean.data.stereotype = n.data.stereotype;
        clean.data.description = n.data.description;
        if (n.data.kind === 'frame') {
          clean.width = n.width ?? 600;
          clean.height = n.height ?? 360;
        }
        return clean;
      }),
      edges: d.edges.map(e => ({ id: e.id, source: e.source, target: e.target, type: 'uml', data: { relation: e.data!.relation, label: e.data!.label, sourceCardinality: e.data!.sourceCardinality, targetCardinality: e.data!.targetCardinality } })),
    })),
  };
}

export function checkDiagram(d: Diagram, locale: Locale = 'sl'): string[] {
  const t = translate.bind(null, locale);
  d = { ...d, nodes: d.nodes.filter(n => n.data.kind !== 'frame') };
  const issues: string[] = [];
  if (!d.nodes.length) return [t('emptyDiagram')];
  for (const n of d.nodes) {
    const incoming = d.edges.filter(e => e.target === n.id);
    const outgoing = d.edges.filter(e => e.source === n.id);
    const label = n.data.label || t(kinds[n.data.kind]);
    if (!n.data.label.trim()) issues.push(t('missingName', { label }));
    if (d.nodes.length > 1 && !incoming.length && !outgoing.length && n.data.kind !== 'note') issues.push(t('disconnected', { label }));
    if (d.id === 'activity') {
      if (n.data.kind === 'decision' && outgoing.length !== 2) issues.push(t('decisionBranches', { label }));
      if (n.data.kind === 'fork' && outgoing.length < 2) issues.push(t('forkBranches', { label }));
      if (n.data.kind === 'join' && incoming.length < 2) issues.push(t('joinInputs', { label }));
      if (n.data.kind === 'start' && (incoming.length || outgoing.length !== 1)) issues.push(t('startConnections', { label }));
      if (n.data.kind === 'end' && outgoing.length) issues.push(t('endConnections', { label }));
      if (!['end', 'decision', 'fork', 'start'].includes(n.data.kind) && !outgoing.length) issues.push(t('missingNextStep', { label }));
    }
  }
  if (d.id === 'activity') {
    const starts = d.nodes.filter(n => n.data.kind === 'start');
    if (starts.length !== 1) issues.push(t('missingStart'));
    if (!d.nodes.some(n => n.data.kind === 'end')) issues.push(t('missingEnd'));
    if (starts.length === 1) {
      const reached = new Set([starts[0].id]);
      for (let i = 0; i < d.nodes.length; i++) for (const e of d.edges) if (reached.has(e.source)) reached.add(e.target);
      for (const n of d.nodes) if (!reached.has(n.id)) issues.push(t('unreachable', { label: n.data.label }));
    }
  }
  return [...new Set(issues)];
}
