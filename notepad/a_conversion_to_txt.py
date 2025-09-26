import os

# === CONFIG ===
source_folder = r"E:\1. Github\1. miRNA-RNA-Deep-Learning-Model\codes\Version 4"
dest_folder = os.path.join(source_folder, "converted_to_notepad")

# File extensions to convert
extensions = {".py", ".css", ".js", ".html"}

# --- Walk through source folder ---
for root, dirs, files in os.walk(source_folder):
    for file in files:
        ext = os.path.splitext(file)[1].lower()
        if ext in extensions:
            src_path = os.path.join(root, file)

            # Determine relative path from source_folder
            rel_path = os.path.relpath(root, source_folder)

            # Create corresponding folder in dest_folder
            dest_subfolder = os.path.join(dest_folder, rel_path)
            os.makedirs(dest_subfolder, exist_ok=True)

            # Destination file path with .txt extension
            dest_filename = os.path.splitext(file)[0] + ".txt"
            dest_path = os.path.join(dest_subfolder, dest_filename)

            # Copy file content to .txt
            with open(src_path, "r", encoding="utf-8", errors="ignore") as f_src:
                content = f_src.read()
            with open(dest_path, "w", encoding="utf-8") as f_dest:
                f_dest.write(content)

            print(f"✅ Converted: {src_path} → {dest_path}")

print("\n🎯 Conversion complete — folder structure preserved in 'converted_to_notepad'.")
