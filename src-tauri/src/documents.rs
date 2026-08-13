/// Extract plain text from a PDF.
///
/// Runs in Rust rather than the WebView: pdf.js needs a web worker, and loading
/// one over Tauri's asset protocol fails in WKWebView with an unactionable
/// minified error. Parsing here also keeps a large, CPU-bound job off the UI thread.
#[tauri::command]
pub async fn extract_pdf_text(data: Vec<u8>) -> Result<String, String> {
    // spawn_blocking so PDF parsing never stalls the async runtime, and so a
    // panic inside the parser surfaces as an error instead of taking down the app.
    tauri::async_runtime::spawn_blocking(move || {
        pdf_extract::extract_text_from_mem(&data)
            .map_err(|e| format!("Failed to parse PDF: {e}"))
    })
    .await
    .map_err(|_| "PDF parsing failed unexpectedly.".to_string())?
}
