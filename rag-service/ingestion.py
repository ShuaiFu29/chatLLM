import io
import time
from datetime import datetime
from database import get_supabase_client
from embeddings import get_embeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter, MarkdownHeaderTextSplitter
import pypdf

supabase = get_supabase_client()

def process_file(file_id: str):
    
    try:
        supabase.table("files").update({
            "status": "processing",
            "progress": 0
        }).eq("id", file_id).execute()

        response = supabase.table("files").select("*").eq("id", file_id).execute()
        if not response.data:
            raise ValueError(f"File {file_id} not found")
        
        file_data = response.data[0]
        storage_path = file_data["storage_path"]
        file_type = file_data["file_type"]
        user_id = file_data["user_id"]

        file_bytes = supabase.storage.from_("documents").download(storage_path)
        
        text_content = ""
        is_markdown = False
        
        if file_type == "application/pdf" or storage_path.lower().endswith(".pdf"):
            pdf_stream = io.BytesIO(file_bytes)
            reader = pypdf.PdfReader(pdf_stream)
            for page in reader.pages:
                text_content += page.extract_text() + "\n"
        elif file_type == "text/markdown" or storage_path.lower().endswith(".md"):
            text_content = file_bytes.decode("utf-8")
            is_markdown = True
        else:
            text_content = file_bytes.decode("utf-8")

        if not text_content.strip():
            raise ValueError("File content is empty")

        chunks = []
        
        if is_markdown:
            headers_to_split_on = [
                ("#", "Header 1"),
                ("##", "Header 2"),
                ("###", "Header 3"),
            ]
            markdown_splitter = MarkdownHeaderTextSplitter(headers_to_split_on=headers_to_split_on)
            md_header_splits = markdown_splitter.split_text(text_content)
            
            text_splitter = RecursiveCharacterTextSplitter(
                chunk_size=1000,
                chunk_overlap=100,
                separators=["\n\n", "\n", "。", "！", "？", ".", " ", ""]
            )
            chunks = text_splitter.split_documents(md_header_splits)
            chunks = [doc.page_content for doc in chunks]
        else:
            text_splitter = RecursiveCharacterTextSplitter(
                chunk_size=1000,
                chunk_overlap=100,
                separators=["\n\n", "\n", "。", "！", "？", ".", " ", ""]
            )
            chunks = text_splitter.split_text(text_content)
            
        total_chunks = len(chunks)

        supabase.table("documents").delete().eq("file_id", file_id).execute()

        batch_size = 20
        processed_count = 0
        
        for i in range(0, total_chunks, batch_size):
            batch_chunks = chunks[i : i + batch_size]
            embeddings = get_embeddings(batch_chunks)
            
            rows_to_insert = []
            for j, chunk in enumerate(batch_chunks):
                rows_to_insert.append({
                    "content": chunk,
                    "metadata": {
                        "filename": file_data["filename"],
                        "file_type": file_type,
                        "user_id": user_id,
                        "source_file_id": file_id
                    },
                    "file_id": file_id,
                    "embedding": embeddings[j]
                })
            
            supabase.table("documents").insert(rows_to_insert).execute()
            
            processed_count += len(batch_chunks)
            progress = int((processed_count / total_chunks) * 100)
            
            supabase.table("files").update({"progress": progress}).eq("id", file_id).execute()

        supabase.table("files").update({
            "status": "completed",
            "progress": 100,
            "updated_at": datetime.utcnow().isoformat()
        }).eq("id", file_id).execute()
        
        return {"status": "success", "chunks": total_chunks}

    except Exception as e:
        supabase.table("files").update({
            "status": "failed",
            "error_message": str(e),
            "updated_at": datetime.utcnow().isoformat()
        }).eq("id", file_id).execute()
        raise e
