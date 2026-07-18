#!/usr/bin/env python3
"""Give every Clone Centre PDF a full black canvas and readable dark-theme pages."""

from __future__ import annotations

import argparse
from pathlib import Path

import pdfplumber
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ContentStream, FloatObject


PAINT_PATH = {b"f", b"F", b"f*", b"S", b"s", b"B", b"B*", b"b", b"b*"}
SHOW_TEXT = {b"Tj", b"TJ", b"'", b'"'}


def light_page_flags(path: Path) -> list[bool]:
    flags: list[bool] = []
    with pdfplumber.open(path) as document:
        for page in document.pages:
            image = page.to_image(resolution=18, antialias=False).original.convert("RGB")
            pixels = list(image.getdata())
            light_ratio = sum(1 for red, green, blue in pixels if (red + green + blue) / 3 > 220) / len(pixels)
            flags.append(light_ratio > 0.45)
    return flags


def rgb(operands) -> tuple[float, float, float]:
    return tuple(float(value) for value in operands[:3])


def luminance(colour: tuple[float, float, float]) -> float:
    red, green, blue = colour
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def saturation(colour: tuple[float, float, float]) -> float:
    return max(colour) - min(colour)


def next_consumer(operations, start: int) -> str | None:
    for operands, operator in operations[start + 1 :]:
        if operator in {b"rg", b"g", b"k"}:
            return None
        if operator in SHOW_TEXT or operator == b"BT":
            return "text"
        if operator in PAINT_PATH:
            return "shape"
    return None


def colour_operands(values: tuple[float, float, float]):
    return [FloatObject(value) for value in values]


def transform_page(page, pdf, make_dark: bool) -> None:
    content = ContentStream(page.get_contents(), pdf)
    operations = list(content.operations)
    transformed = []

    for index, (operands, operator) in enumerate(operations):
        new_operands = operands
        if operator == b"rg" and len(operands) >= 3:
            colour = rgb(operands)
            consumer = next_consumer(operations, index)
            level = luminance(colour)
            spread = saturation(colour)

            # The original exports begin with a white page rectangle. Replace it
            # with black so there is no white rim around dark interiors.
            if index < 12 and level > 0.9 and consumer == "shape":
                new_operands = colour_operands((0.0, 0.0, 0.0))
            elif make_dark and consumer == "shape" and level > 0.82 and spread < 0.2:
                new_operands = colour_operands((0.025, 0.04, 0.065))
            elif make_dark and consumer == "text" and 0.015 < level < 0.38 and max(colour) < 0.55:
                if level < 0.18:
                    new_operands = colour_operands((0.93, 0.94, 0.95))
                else:
                    new_operands = colour_operands((0.67, 0.72, 0.78))

        transformed.append((new_operands, operator))

    left = float(page.mediabox.left)
    bottom = float(page.mediabox.bottom)
    width = float(page.mediabox.width)
    height = float(page.mediabox.height)
    black_canvas = [
        ([], b"q"),
        (colour_operands((0.0, 0.0, 0.0)), b"rg"),
        ([FloatObject(left), FloatObject(bottom), FloatObject(width), FloatObject(height)], b"re"),
        ([], b"f"),
        ([], b"Q"),
    ]
    content.operations = black_canvas + transformed
    page.replace_contents(content)


def process_pdf(source: Path, destination: Path) -> int:
    flags = light_page_flags(source)
    reader = PdfReader(source)
    writer = PdfWriter()
    for page, make_dark in zip(reader.pages, flags, strict=True):
        transform_page(page, reader, make_dark)
        writer.add_page(page)
    if reader.metadata:
        metadata = {key: str(value) for key, value in reader.metadata.items() if value is not None}
        writer.add_metadata(metadata)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as output:
        writer.write(output)
    return len(reader.pages)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--books-dir", type=Path, default=Path("books"))
    parser.add_argument("--output-dir", type=Path, default=Path("output/pdf"))
    args = parser.parse_args()

    sources = sorted(path for path in args.books_dir.rglob("*.pdf") if path.is_file())
    total_pages = 0
    for source in sources:
        relative = source.relative_to(args.books_dir)
        destination = args.output_dir / relative
        pages = process_pdf(source, destination)
        total_pages += pages
        print(f"{relative}: {pages} pages")
    print(f"Processed {len(sources)} PDFs / {total_pages} pages")


if __name__ == "__main__":
    main()
