"""
Font detection module for PDF analysis.
Detects the dominant font in a PDF from pre-extracted text spans and maps it
to an available .ttf file in assets/fonts/.

Also usable as a standalone script to scan a directory tree for font metadata.
"""

import os

# Maps font name keywords (lowercase) to .ttf filenames in assets/fonts/.
# Evaluated in order; first match wins.
# NOTE: "roman" is intentionally omitted — it is a generic style suffix used by
# many non-Times fonts (e.g. "Garamond-Roman", "HelveticaNeue-Roman") and would
# cause widespread false positives.  "times" alone is sufficient to match every
# legitimate Times New Roman variant (TimesNewRomanPSMT, Times-Roman, TimesMT…).
FONT_MAP = [
    (["times"],    "times.ttf"),
    (["courier"],  "courier_new.ttf"),
    (["arial"],    "arial.ttf"),
    (["calibri"],  "calibri.ttf"),
]

# Minimum character count before a font is considered significant
MIN_CHARS = 35


def _map_pdf_font_to_file(pdf_font_name, available_fonts):
    """Map a PDF internal font name to a .ttf filename from available_fonts."""
    low = pdf_font_name.lower()
    for keywords, ttf_file in FONT_MAP:
        if any(kw in low for kw in keywords):
            if ttf_file in available_fonts:
                return ttf_file
    return None





# ---------------------------------------------------------------------------
# Standalone script — scan a directory tree for font metadata
# ---------------------------------------------------------------------------

def extract_specific_fonts(base_dir, target_folders):
    """
    Scan specified folders inside base_dir for PDF files, extract font metadata,
    and print fonts matching Times New Roman, Courier New, Calibri, or Arial.
    """
    try:
        import fitz
    except ImportError:
        print("PyMuPDF (fitz) is required for standalone scanning.")
        return

    target_font_keywords = ["times", "courier", "calibri", "arial"]

    print(f"Starting font metadata extraction in {base_dir}...\n")

    for folder in target_folders:
        folder_path = os.path.join(base_dir, folder)
        if not os.path.exists(folder_path):
            print(f"Warning: Directory '{folder_path}' does not exist. Skipping.")
            continue

        print(f"--- Processing Directory: {folder_path} ---")

        for root, _, files in os.walk(folder_path):
            for file in files:
                if not file.lower().endswith(".pdf"):
                    continue
                pdf_path = os.path.join(root, file)
                try:
                    doc = fitz.open(pdf_path)

                    # Build character counts per font name from span data
                    font_counts = {}
                    for page in doc:
                        for block in page.get_text("dict").get("blocks", []):
                            if block.get("type") == 0:
                                for line in block.get("lines", []):
                                    for span in line.get("spans", []):
                                        f_name = span.get("font", "")
                                        if f_name:
                                            font_counts[f_name] = (
                                                font_counts.get(f_name, 0)
                                                + len(span.get("text", ""))
                                            )

                    found_target_fonts = set()
                    for page_num in range(len(doc)):
                        for font in doc.get_page_fonts(page_num):
                            font_name = font[3] if len(font) > 3 and font[3] else ""
                            font_lower = font_name.lower()
                            if any(kw in font_lower for kw in target_font_keywords):
                                if font_counts.get(font_name, 0) >= MIN_CHARS:
                                    found_target_fonts.add(
                                        (font[2], font_name, font[5] if len(font) > 5 else "N/A")
                                    )

                    doc.close()

                    if not found_target_fonts:
                        continue

                    print(f"\nFile: {file}")
                    best_font = max(
                        (f_name for _, f_name, _ in found_target_fonts),
                        key=lambda n: font_counts.get(n, 0),
                    )
                    for f_type, f_name, f_enc in sorted(found_target_fonts):
                        chars = font_counts.get(f_name, 0)
                        tag = " [PRIMARY FONT]" if f_name == best_font else ""
                        print(f"  - Font: {f_name} ({chars} chars) (Type: {f_type}, Encoding: {f_enc}){tag}")

                except Exception as e:
                    print(f"Error processing {pdf_path}: {e}")


if __name__ == "__main__":
    base_directory = r"c:\Users\yanni\Desktop\FontMetadata"
    target_directories = [
        r"assets\times",
        r"assets\calibri",
        r"assets\courier",
        r"assets\Arial",
    ]
    extract_specific_fonts(base_directory, target_directories)
