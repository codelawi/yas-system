import { useEffect } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import { Node, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { FontSize, TextStyle } from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { Button, Dropdown, Select, Tooltip } from 'antd'
import {
  AlignCenterOutlined,
  AlignLeftOutlined,
  AlignRightOutlined,
  BoldOutlined,
  BorderOuterOutlined,
  BorderlessTableOutlined,
  DeleteColumnOutlined,
  DeleteOutlined,
  DeleteRowOutlined,
  InsertRowAboveOutlined,
  InsertRowBelowOutlined,
  InsertRowLeftOutlined,
  InsertRowRightOutlined,
  ItalicOutlined,
  MergeCellsOutlined,
  RedoOutlined,
  SplitCellsOutlined,
  TableOutlined,
  TagOutlined,
  UnderlineOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { useLang } from '../i18n'

/*
 * A Word-like editor for the header or footer of a voucher template. Placeholders (recipient,
 * number, page..., and the template's own fields) are kept as <span data-field="..."> and filled
 * in when the voucher is printed (see VoucherPaper). The editing area is as wide as the printed
 * page, with the same fonts, so what you see is what prints.
 */

/** A placeholder: shown as a chip with its name, printed as its value. */
const VoucherField = Node.create({
  name: 'voucherField',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      field: { default: '', parseHTML: (el) => el.getAttribute('data-field'), renderHTML: (attrs) => ({ 'data-field': attrs.field }) },
      label: { default: '', parseHTML: (el) => el.textContent, renderHTML: () => ({}) },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-field]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'vte-field' }), node.attrs.label || node.attrs.field]
  },
  renderText({ node }) {
    return `{${node.attrs.label || node.attrs.field}}`
  },
})

/** Tables with or without lines (data-borders="none": for laying text out side by side). */
const VoucherTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      borders: {
        default: 'all',
        parseHTML: (el) => el.getAttribute('data-borders') || 'all',
        renderHTML: (attrs) => (attrs.borders === 'none' ? { 'data-borders': 'none' } : {}),
      },
    }
  },
})

const SIZES = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24]

/**
 * `labels` names every placeholder ({ recipient: 'المستلم', 'f:officer': '...' }): chips follow
 * renamed fields, and chips of deleted fields go.
 */
export default function VoucherTemplateEditor({ value, onChange, labels, style }) {
  const { t } = useLang()
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ code: false, codeBlock: false, blockquote: false, horizontalRule: false, link: false }),
      TextStyle,
      FontSize,
      TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['right', 'center', 'left', 'justify'] }),
      VoucherTable.configure({ resizable: true, cellMinWidth: 30 }),
      TableRow,
      TableHeader,
      TableCell,
      VoucherField,
    ],
    content: value || '',
    editorProps: { attributes: { class: 'vp-html vte-surface', dir: 'rtl', lang: 'ar' } },
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
  })

  // Chips follow their field: renamed, or gone with it
  useEffect(() => {
    if (!editor) return
    const changes = []
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'voucherField') return
      const label = labels[node.attrs.field]
      if (label === undefined) changes.push({ pos, size: node.nodeSize, remove: true })
      else if (label !== node.attrs.label) changes.push({ pos, attrs: { ...node.attrs, label } })
    })
    if (!changes.length) return
    const tr = editor.state.tr
    for (const change of changes.reverse()) {
      if (change.remove) tr.delete(change.pos, change.pos + change.size)
      else tr.setNodeMarkup(change.pos, undefined, change.attrs)
    }
    editor.view.dispatch(tr)
  }, [editor, labels])

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e && {
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        align: ['right', 'center', 'left', 'justify'].find((a) => e.isActive({ textAlign: a })) || null,
        size: e.getAttributes('textStyle').fontSize || null,
        inTable: e.isActive('table'),
        borders: e.getAttributes('table').borders,
        undo: e.can().undo(),
        redo: e.can().redo(),
      },
  })
  if (!editor || !state) return null

  const run = (fn) => () => fn(editor.chain().focus()).run()
  const tool = (key, icon, label, onClick, { active = false, disabled = false } = {}) => (
    <Tooltip key={key} title={label}>
      <Button size="small" type={active ? 'primary' : 'text'} icon={icon} aria-label={label} disabled={disabled} onClick={onClick} />
    </Tooltip>
  )
  const insertTable = (cols, rows, borders) =>
    run((c) =>
      c.insertTable({ rows, cols, withHeaderRow: false }).command(({ tr, state: s }) => {
        // The new table: around the cursor now
        for (let depth = s.selection.$from.depth; depth > 0; depth--) {
          const node = s.selection.$from.node(depth)
          if (node.type.name === 'table') {
            tr.setNodeMarkup(s.selection.$from.before(depth), undefined, { ...node.attrs, borders })
            break
          }
        }
        return true
      }),
    )()

  const fieldItems = Object.entries(labels).map(([field, label]) => ({
    key: field,
    label,
    onClick: () => editor.chain().focus().insertContent({ type: 'voucherField', attrs: { field, label } }).run(),
  }))
  const tableItems = state.inTable
    ? [
        { key: 'row-above', icon: <InsertRowAboveOutlined />, label: t('vte_row_above'), onClick: run((c) => c.addRowBefore()) },
        { key: 'row-below', icon: <InsertRowBelowOutlined />, label: t('vte_row_below'), onClick: run((c) => c.addRowAfter()) },
        // Right-to-left: "before" is on the right
        { key: 'col-right', icon: <InsertRowRightOutlined />, label: t('vte_col_right'), onClick: run((c) => c.addColumnBefore()) },
        { key: 'col-left', icon: <InsertRowLeftOutlined />, label: t('vte_col_left'), onClick: run((c) => c.addColumnAfter()) },
        { type: 'divider' },
        { key: 'merge', icon: <MergeCellsOutlined />, label: t('vte_merge'), onClick: run((c) => c.mergeCells()) },
        { key: 'split', icon: <SplitCellsOutlined />, label: t('vte_split'), onClick: run((c) => c.splitCell()) },
        {
          key: 'borders',
          icon: state.borders === 'none' ? <BorderOuterOutlined /> : <BorderlessTableOutlined />,
          label: t(state.borders === 'none' ? 'vte_show_lines' : 'vte_hide_lines'),
          onClick: run((c) => c.updateAttributes('table', { borders: state.borders === 'none' ? 'all' : 'none' })),
        },
        { type: 'divider' },
        { key: 'del-row', icon: <DeleteRowOutlined />, label: t('vte_delete_row'), danger: true, onClick: run((c) => c.deleteRow()) },
        { key: 'del-col', icon: <DeleteColumnOutlined />, label: t('vte_delete_col'), danger: true, onClick: run((c) => c.deleteColumn()) },
        { key: 'del-table', icon: <DeleteOutlined />, label: t('vte_delete_table'), danger: true, onClick: run((c) => c.deleteTable()) },
      ]
    : [
        { key: 't2', label: t('vte_table_side', { n: 2 }), onClick: () => insertTable(2, 1, 'none') },
        { key: 't3', label: t('vte_table_side', { n: 3 }), onClick: () => insertTable(3, 1, 'none') },
        { type: 'divider' },
        { key: 'g22', label: t('vte_table_lines', { c: 2, r: 2 }), onClick: () => insertTable(2, 2, 'all') },
        { key: 'g32', label: t('vte_table_lines', { c: 3, r: 2 }), onClick: () => insertTable(3, 2, 'all') },
      ]

  return (
    <div className="vte">
      <div className="vte-toolbar">
        {tool('undo', <UndoOutlined />, t('vte_undo'), run((c) => c.undo()), { disabled: !state.undo })}
        {tool('redo', <RedoOutlined />, t('vte_redo'), run((c) => c.redo()), { disabled: !state.redo })}
        <span className="vte-sep" />
        {tool('bold', <BoldOutlined />, t('vte_bold'), run((c) => c.toggleBold()), { active: state.bold })}
        {tool('italic', <ItalicOutlined />, t('vte_italic'), run((c) => c.toggleItalic()), { active: state.italic })}
        {tool('underline', <UnderlineOutlined />, t('vte_underline'), run((c) => c.toggleUnderline()), { active: state.underline })}
        <Select
          size="small"
          className="vte-size"
          value={state.size ? parseInt(state.size, 10) : ''}
          aria-label={t('vte_size')}
          onChange={(v) => (v ? editor.chain().focus().setFontSize(`${v}pt`).run() : editor.chain().focus().unsetFontSize().run())}
          options={[{ value: '', label: `${style.font_size}` }, ...SIZES.map((s) => ({ value: s, label: `${s}` }))]}
          popupMatchSelectWidth={false}
        />
        <span className="vte-sep" />
        {tool('right', <AlignRightOutlined />, t('vte_align_right'), run((c) => (state.align === 'right' ? c.unsetTextAlign() : c.setTextAlign('right'))), { active: state.align === 'right' })}
        {tool('center', <AlignCenterOutlined />, t('vte_align_center'), run((c) => (state.align === 'center' ? c.unsetTextAlign() : c.setTextAlign('center'))), { active: state.align === 'center' })}
        {tool('left', <AlignLeftOutlined />, t('vte_align_left'), run((c) => (state.align === 'left' ? c.unsetTextAlign() : c.setTextAlign('left'))), { active: state.align === 'left' })}
        <span className="vte-sep" />
        <Dropdown menu={{ items: tableItems }} trigger={['click']}>
          <Button size="small" type={state.inTable ? 'primary' : 'text'} icon={<TableOutlined />}>
            {t('vte_table')}
          </Button>
        </Dropdown>
        <Dropdown menu={{ items: fieldItems }} trigger={['click']}>
          <Button size="small" type="text" icon={<TagOutlined />}>
            {t('vte_insert_field')}
          </Button>
        </Dropdown>
      </div>
      <div className="vte-scroll">
        <div className="vte-paper" style={{ width: `calc(148mm - ${2 * style.margin}mm)`, fontSize: `${style.font_size}pt` }}>
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  )
}
