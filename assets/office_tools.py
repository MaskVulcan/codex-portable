"""Small, offline-first office helpers for the bundled Python.

This file intentionally imports heavy libraries only inside the commands using them.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile


def convert_office(source: Path, target: Path) -> Path:
    if os.name != 'nt':
        raise RuntimeError('Office/WPS 自动转换只支持 Windows。')
    if source.resolve() == target.resolve():
        raise ValueError('转换结果必须使用新的文件名，不能覆盖原文件。')
    if target.suffix.lower() not in ('.docx', '.pdf'):
        raise ValueError('仅支持转换为 .docx 或 .pdf。')
    import comtypes.client
    errors = []
    for progid in ('kwps.Application', 'wps.Application', 'Word.Application'):
        app = doc = None
        try:
            app = comtypes.client.CreateObject(progid, dynamic=True)
            app.Visible = False
            try:
                app.DisplayAlerts = 0
            except Exception:
                pass
            doc = app.Documents.Open(str(source.resolve()), ReadOnly=True)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.suffix.lower() == '.pdf':
                try:
                    doc.ExportAsFixedFormat(str(target.resolve()), 17)
                except Exception:
                    doc.SaveAs(str(target.resolve()), 17)
            else:
                try:
                    doc.SaveAs2(str(target.resolve()), 16)
                except Exception:
                    doc.SaveAs(str(target.resolve()), 16)
            if not target.exists() or target.stat().st_size == 0:
                raise RuntimeError('办公软件未生成目标文件。')
            return target
        except Exception as error:
            errors.append(f'{progid}: {error}')
        finally:
            if doc is not None:
                try:
                    doc.Close(False)
                except Exception:
                    pass
            if app is not None:
                try:
                    app.Quit()
                except Exception:
                    pass
    raise RuntimeError('未能通过 WPS/Word 转换。可能未安装 COM 自动化组件；可以让用户在 WPS 中另存为 DOCX/PDF。\n' + '\n'.join(errors))


def extract(source: Path) -> str:
    suffix = source.suffix.lower()
    if suffix == '.doc':
        with tempfile.TemporaryDirectory(prefix='office-convert-') as temp:
            converted = convert_office(source, Path(temp) / 'converted.docx')
            return extract(converted)
    if suffix == '.docx':
        from docx import Document
        document = Document(source)
        parts = [p.text for p in document.paragraphs if p.text.strip()]
        for table in document.tables:
            parts.append('\n'.join('\t'.join(cell.text for cell in row.cells) for row in table.rows))
        return '\n\n'.join(parts)
    if suffix == '.pdf':
        import fitz
        with fitz.open(source) as pdf:
            return '\n\n'.join(f'--- 第 {i+1} 页 ---\n{page.get_text()}' for i, page in enumerate(pdf))
    if suffix in ('.xlsx', '.xlsm'):
        from openpyxl import load_workbook
        book = load_workbook(source, read_only=True, data_only=True)
        try:
            parts = []
            for sheet in book:
                parts.append('--- ' + sheet.title + ' ---')
                parts.extend('\t'.join('' if c is None else str(c) for c in row) for row in sheet.iter_rows(values_only=True))
            return '\n'.join(parts)
        finally:
            book.close()
    for encoding in ('utf-8-sig', 'utf-16', 'gb18030'):
        try:
            return source.read_text(encoding=encoding)
        except UnicodeError:
            continue
    raise ValueError('无法作为文本读取，请用适合该格式的库处理。')


def inspect(source: Path) -> dict:
    result = {'path': str(source.resolve()), 'name': source.name, 'bytes': source.stat().st_size}
    if source.suffix.lower() == '.pdf':
        import fitz
        with fitz.open(source) as pdf:
            result.update(pages=len(pdf), encrypted=pdf.is_encrypted, metadata=pdf.metadata)
            if not pdf.is_encrypted:
                result['page_text_chars'] = [len(p.get_text()) for p in pdf]
                result['possibly_scanned_pages'] = [i+1 for i,p in enumerate(pdf) if len(p.get_text().strip()) < 10]
    elif source.suffix.lower() == '.docx':
        from docx import Document
        document = Document(source)
        result.update(paragraphs=len(document.paragraphs), tables=len(document.tables), sections=len(document.sections))
    elif source.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff'):
        from PIL import Image
        with Image.open(source) as image:
            result.update(width=image.width, height=image.height, format=image.format, mode=image.mode, frames=getattr(image, 'n_frames', 1))
    return result


def render_pdf(source: Path, target: Path, pages: str | None, dpi: int):
    import fitz
    target.mkdir(parents=True, exist_ok=True)
    with fitz.open(source) as pdf:
        chosen = range(len(pdf)) if not pages else [int(p.strip())-1 for p in pages.split(',')]
        output = []
        for index in chosen:
            if index < 0 or index >= len(pdf):
                raise ValueError(f'页码超出范围：{index+1}')
            page = pdf[index]
            result = target / f'page-{index+1:03d}.png'
            page.get_pixmap(dpi=dpi, alpha=False).save(result)
            output.append(str(result.resolve()))
        return output


def main():
    parser = argparse.ArgumentParser(description='便携办公工具：读取 DOCX/PDF/表格、渲染 PDF、通过 WPS 转换 DOC。')
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('validate', help='检查生成文件是否可打开；仅结构检查，不代表内容准确')
    p.add_argument('files', nargs='+', type=Path)
    for command in ('inspect', 'extract'):
        p = sub.add_parser(command)
        p.add_argument('file', type=Path)
        if command == 'extract':
            p.add_argument('--output', type=Path)
    p = sub.add_parser('render-pdf')
    p.add_argument('file', type=Path)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--pages', help='用逗号分隔的页码，从 1 开始；默认全部页')
    p.add_argument('--dpi', type=int, default=130)
    p = sub.add_parser('convert-office')
    p.add_argument('file', type=Path)
    p.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'validate':
        results = []
        for file in args.files:
            result = {'path': str(file), 'valid': False, 'checked': '文件结构'}
            try:
                if file.stat().st_size == 0:
                    raise ValueError('文件为空')
                suffix = file.suffix.lower()
                if suffix in ('.docx', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff'):
                    info = inspect(file)
                    if info.get('encrypted'):
                        raise ValueError('文件已加密，需要密码才能检查')
                    if suffix == '.pdf' and not info.get('pages'):
                        raise ValueError('PDF 没有页面')
                    result['details'] = info
                elif suffix in ('.xlsx', '.xlsm'):
                    from openpyxl import load_workbook
                    book = load_workbook(file, read_only=True)
                    book.close()
                elif suffix == '.zip':
                    import zipfile
                    with zipfile.ZipFile(file) as archive:
                        if archive.testzip():
                            raise ValueError('ZIP 数据损坏')
                else:
                    result['checked'] = '存在且非空'
                result['valid'] = True
            except Exception as error:
                result['error'] = str(error)
            results.append(result)
        print(json.dumps(results, ensure_ascii=False))
        return
    if not args.file.is_file():
        parser.error('找不到输入文件：' + str(args.file))
    if args.command == 'inspect':
        print(json.dumps(inspect(args.file), ensure_ascii=False, indent=2))
    elif args.command == 'extract':
        text = extract(args.file)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(text, encoding='utf-8')
            print(str(args.output.resolve()))
        else:
            print(text)
    elif args.command == 'render-pdf':
        if not 36 <= args.dpi <= 400:
            parser.error('DPI 应在 36 到 400 之间')
        print(json.dumps(render_pdf(args.file, args.output, args.pages, args.dpi), ensure_ascii=False, indent=2))
    else:
        print(str(convert_office(args.file, args.output).resolve()))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('处理失败：' + str(error), file=sys.stderr)
        sys.exit(1)
