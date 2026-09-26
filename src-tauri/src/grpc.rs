// gRPC calls for the HTTP client. Messages are built at run time from the service's schema, which
// comes from the server's reflection service, or else from the project's .proto files, compiled by
// protox, so there's no protoc to install.
use prost::Message;
use prost_reflect::prost_types::{FileDescriptorProto, FileDescriptorSet};
use prost_reflect::{DescriptorPool, DynamicMessage, MessageDescriptor, MethodDescriptor, SerializeOptions};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;
use tokio::sync::oneshot;
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::codegen::http::uri::PathAndQuery;
use tonic::metadata::MetadataMap;
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use tonic::{Code, Status};
use tonic_reflection::pb::v1::server_reflection_request::MessageRequest;
use tonic_reflection::pb::v1::server_reflection_response::MessageResponse;
use tonic_reflection::pb::v1::{ServerReflectionRequest, ServerReflectionResponse};

/// Calls in flight by the caller's ID, each with the sender that cancels it.
#[derive(Default)]
pub struct GrpcState(Mutex<HashMap<String, oneshot::Sender<()>>>);

/// A call's result, shaped like an HTTP response: gRPC's status as the HTTP status Google maps it to,
/// its name as the status text, the metadata and trailers as headers, and the messages as JSON.
#[derive(Serialize, Debug)]
pub struct GrpcResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: String,
    seconds: f64,
}

/// `[grpc://|grpcs://|http://|https://]host:port/package.Service/Method`: whether it uses TLS, the
/// address, the service, and the method.
fn parse_target(target: &str) -> Result<(bool, &str, &str, &str), String> {
    let (tls, rest) = match target.split_once("://") {
        Some(("grpcs" | "https", rest)) => (true, rest),
        Some(("grpc" | "http", rest)) => (false, rest),
        Some((scheme, _)) => return Err(format!("{scheme}:// isn't a gRPC scheme. Use grpc:// or grpcs://.")),
        None => (false, target),
    };
    let (address, path) = rest.split_once('/').ok_or("Write the address as host:port/package.Service/Method")?;
    let (service, method) = path.trim_end_matches('/').rsplit_once('/').unwrap_or((path, ""));
    Ok((tls, address, service, method))
}

async fn connect(tls: bool, address: &str, connect_timeout: f64) -> Result<Channel, String> {
    let url = format!("{}://{address}", if tls { "https" } else { "http" });
    let mut endpoint = Endpoint::from_shared(url).map_err(|e| e.to_string())?.connect_timeout(Duration::from_secs_f64(connect_timeout));
    if tls {
        let _ = rustls::crypto::ring::default_provider().install_default();
        endpoint = endpoint.tls_config(ClientTlsConfig::new().with_native_roots()).map_err(|e| e.to_string())?;
    }
    endpoint.connect().await.map_err(|e| format!("Couldn't connect to {address}: {}", source(&e)))
}

/// The innermost cause, which says what went wrong, rather than tonic's "transport error".
fn source(e: &(dyn std::error::Error + 'static)) -> String {
    let mut e = e;
    while let Some(inner) = e.source() {
        e = inner;
    }
    e.to_string()
}

/// Encodes and decodes messages whose types are known only at run time.
struct DynamicCodec(MessageDescriptor);

impl Codec for DynamicCodec {
    type Encode = DynamicMessage;
    type Decode = DynamicMessage;
    type Encoder = DynamicCodec;
    type Decoder = DynamicCodec;
    fn encoder(&mut self) -> Self::Encoder {
        DynamicCodec(self.0.clone())
    }
    fn decoder(&mut self) -> Self::Decoder {
        DynamicCodec(self.0.clone())
    }
}

impl Encoder for DynamicCodec {
    type Item = DynamicMessage;
    type Error = Status;
    fn encode(&mut self, item: DynamicMessage, dst: &mut EncodeBuf<'_>) -> Result<(), Status> {
        item.encode(dst).map_err(|e| Status::internal(e.to_string()))
    }
}

impl Decoder for DynamicCodec {
    type Item = DynamicMessage;
    type Error = Status;
    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<DynamicMessage>, Status> {
        DynamicMessage::decode(self.0.clone(), src).map(Some).map_err(|e| Status::internal(e.to_string()))
    }
}

/// Sends one reflection request, on v1 and then v1alpha, whose messages are the same on the wire.
async fn reflect(channel: &Channel, request: MessageRequest) -> Result<MessageResponse, Status> {
    let mut last = Status::unimplemented("");
    for path in ["/grpc.reflection.v1.ServerReflection/ServerReflectionInfo", "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo"] {
        let mut grpc = tonic::client::Grpc::new(channel.clone());
        grpc.ready().await.map_err(|e| Status::unavailable(source(&e)))?;
        let message = ServerReflectionRequest { host: String::new(), message_request: Some(request.clone()) };
        let codec = tonic_prost::ProstCodec::<ServerReflectionRequest, ServerReflectionResponse>::default();
        match grpc.streaming(tonic::Request::new(tokio_stream::once(message)), PathAndQuery::from_static(path), codec).await {
            Ok(response) => {
                let reply = response.into_inner().message().await?.and_then(|r| r.message_response);
                return match reply {
                    Some(MessageResponse::ErrorResponse(e)) => Err(Status::new(Code::from(e.error_code), e.error_message)),
                    Some(reply) => Ok(reply),
                    None => Err(Status::unknown("The reflection service didn't answer")),
                };
            }
            Err(status) if status.code() == Code::Unimplemented => last = status,
            Err(status) => return Err(status),
        }
    }
    Err(last)
}

/// The files that define `symbol`, and every file they import, from the server's reflection service.
async fn reflected_pool(channel: &Channel, symbol: &str) -> Result<DescriptorPool, Status> {
    let mut files: HashMap<String, FileDescriptorProto> = HashMap::new();
    let mut next = vec![MessageRequest::FileContainingSymbol(symbol.to_string())];
    let mut asked = HashSet::new();
    while let Some(request) = next.pop() {
        let Some(MessageResponse::FileDescriptorResponse(found)) = Some(reflect(channel, request).await?) else { continue };
        for bytes in found.file_descriptor_proto {
            let file = FileDescriptorProto::decode(bytes.as_slice()).map_err(|e| Status::internal(e.to_string()))?;
            for dependency in &file.dependency {
                if !files.contains_key(dependency) && asked.insert(dependency.clone()) {
                    next.push(MessageRequest::FileByFilename(dependency.clone()));
                }
            }
            files.insert(file.name().to_string(), file);
        }
    }
    DescriptorPool::from_file_descriptor_set(FileDescriptorSet { file: files.into_values().collect() }).map_err(|e| Status::internal(e.to_string()))
}

/// The project's .proto files, skipping ignored folders such as vendor and node_modules.
fn proto_files(root: &Path) -> Vec<PathBuf> {
    ignore::WalkBuilder::new(root).build().flatten().map(|e| e.into_path()).filter(|p| p.extension().is_some_and(|x| x == "proto")).collect()
}

/// Compiles one .proto file. Its imports are looked up from its folder and each folder above it up
/// to the project's root, which covers imports relative to a `proto/` folder or to the root.
fn compile(root: &Path, file: &Path) -> Result<DescriptorPool, String> {
    let includes: Vec<&Path> = file.ancestors().skip(1).take_while(|d| d.starts_with(root)).collect();
    let mut compiler = protox::Compiler::new(includes).map_err(|e| e.to_string())?;
    compiler.include_imports(true).open_file(file).map_err(|e| e.to_string())?;
    Ok(compiler.descriptor_pool())
}

/// A pool with `service` from the project's .proto files: the first file that declares it and compiles.
fn project_pool(root: &Path, service: &str) -> Result<DescriptorPool, String> {
    let short = service.rsplit('.').next().unwrap_or(service);
    let declares = regex::Regex::new(&format!(r"\bservice\s+{}\b", regex::escape(short))).map_err(|e| e.to_string())?;
    let mut error = None;
    for file in proto_files(root) {
        if !std::fs::read_to_string(&file).is_ok_and(|text| declares.is_match(&text)) {
            continue;
        }
        match compile(root, &file) {
            Ok(pool) if pool.get_service_by_name(service).is_some() => return Ok(pool),
            Ok(_) => {}
            Err(e) => error = Some(e),
        }
    }
    Err(error.unwrap_or_else(|| format!("No .proto file in the project declares {service}")))
}

/// The method's descriptor, from reflection or else the project's .proto files.
async fn find_method(channel: &Channel, root: &Path, service: &str, method: &str) -> Result<MethodDescriptor, String> {
    let pool = match reflected_pool(channel, service).await {
        Ok(pool) => pool,
        Err(reflection) => project_pool(root, service).map_err(|e| format!("The server's reflection failed ({}), and {e}", reflection.message()))?,
    };
    let s = pool.get_service_by_name(service).ok_or(format!("{service} isn't a service the schema defines"))?;
    let found = s.methods().find(|m| m.name() == method);
    found.ok_or_else(|| format!("{service} has no method {method}. It has {}.", s.methods().map(|m| m.name().to_string()).collect::<Vec<_>>().join(", ")))
}

/// Google's mapping of gRPC status codes to HTTP statuses, with the code's name.
fn http_status(code: Code) -> (u16, &'static str) {
    match code {
        Code::Ok => (200, "OK"),
        Code::Cancelled => (499, "CANCELLED"),
        Code::Unknown => (500, "UNKNOWN"),
        Code::InvalidArgument => (400, "INVALID_ARGUMENT"),
        Code::DeadlineExceeded => (504, "DEADLINE_EXCEEDED"),
        Code::NotFound => (404, "NOT_FOUND"),
        Code::AlreadyExists => (409, "ALREADY_EXISTS"),
        Code::PermissionDenied => (403, "PERMISSION_DENIED"),
        Code::ResourceExhausted => (429, "RESOURCE_EXHAUSTED"),
        Code::FailedPrecondition => (400, "FAILED_PRECONDITION"),
        Code::Aborted => (409, "ABORTED"),
        Code::OutOfRange => (400, "OUT_OF_RANGE"),
        Code::Unimplemented => (501, "UNIMPLEMENTED"),
        Code::Internal => (500, "INTERNAL"),
        Code::Unavailable => (503, "UNAVAILABLE"),
        Code::DataLoss => (500, "DATA_LOSS"),
        Code::Unauthenticated => (401, "UNAUTHENTICATED"),
    }
}

fn pairs(metadata: &MetadataMap) -> Vec<(String, String)> {
    let headers = metadata.clone().into_headers();
    headers.iter().map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned())).collect()
}

/// Makes the call. The body is JSON messages one after another: one for a unary or server streaming
/// method, any number for a client or bidirectional streaming one. A streaming method's response is
/// an array of every message the server sent.
async fn call(root: &Path, target: &str, body: &str, metadata: Vec<(String, String)>, timeout: f64, connect_timeout: f64) -> Result<GrpcResponse, String> {
    let (tls, address, service, method) = parse_target(target)?;
    let started = Instant::now();
    let channel = connect(tls, address, connect_timeout).await?;
    let method = find_method(&channel, root, service, method).await?;
    let input = method.input();
    let mut messages = Vec::new();
    for value in serde_json::Deserializer::from_str(body).into_iter::<serde_json::Value>() {
        let value = value.map_err(|e| format!("The body isn't JSON: {e}"))?;
        messages.push(DynamicMessage::deserialize(input.clone(), value).map_err(|e| format!("The body doesn't match {}: {e}", input.full_name()))?);
    }
    if messages.is_empty() {
        messages.push(DynamicMessage::new(input.clone()));
    }
    let mut request = tonic::Request::new(tokio_stream::iter(messages));
    for (name, value) in metadata {
        let key = tonic::metadata::MetadataKey::from_bytes(name.to_lowercase().as_bytes()).map_err(|e| format!("{name}: {e}"))?;
        request.metadata_mut().insert(key, value.parse().map_err(|e| format!("{name}: {e}"))?);
    }
    request.set_timeout(Duration::from_secs_f64(timeout));
    let path = PathAndQuery::try_from(format!("/{}/{}", method.parent_service().full_name(), method.name())).map_err(|e| e.to_string())?;
    let mut grpc = tonic::client::Grpc::new(channel);
    grpc.ready().await.map_err(|e| source(&e))?;
    let mut headers = Vec::new();
    let mut replies = Vec::new();
    let status = match grpc.streaming(request, path, DynamicCodec(method.output())).await {
        Ok(response) => {
            headers = pairs(response.metadata());
            let mut stream = response.into_inner();
            let status = loop {
                match stream.message().await {
                    Ok(Some(reply)) => replies.push(reply),
                    Ok(None) => break Status::ok(""),
                    Err(status) => break status,
                }
            };
            if let Ok(Some(trailers)) = stream.trailers().await {
                headers.extend(pairs(&trailers));
            }
            status
        }
        Err(status) => status,
    };
    let options = SerializeOptions::new().skip_default_fields(false);
    let json = |m: &DynamicMessage| m.serialize_with_options(serde_json::value::Serializer, &options).unwrap_or_default();
    let value = if status.code() != Code::Ok && replies.is_empty() {
        serde_json::json!({ "code": http_status(status.code()).1, "message": status.message() })
    } else if method.is_server_streaming() {
        replies.iter().map(json).collect()
    } else {
        replies.first().map(json).unwrap_or_default()
    };
    if status.code() != Code::Ok {
        headers.extend(pairs(status.metadata()));
        headers.push(("grpc-status".into(), (status.code() as i32).to_string()));
        headers.push(("grpc-message".into(), status.message().into()));
    }
    let (code, name) = http_status(status.code());
    Ok(GrpcResponse { status: code, status_text: name.into(), headers, body: serde_json::to_string_pretty(&value).unwrap_or_default(), seconds: started.elapsed().as_secs_f64() })
}

/// Calls `target` (see `parse_target`) with `body` and `metadata`. `grpc_cancel` with the same `id`
/// stops it. `root` is the project, whose .proto files are the schema when the server has no reflection.
#[tauri::command]
pub async fn grpc_call(state: State<'_, GrpcState>, id: String, root: String, target: String, body: String, metadata: Vec<(String, String)>, timeout: f64, connect_timeout: f64) -> Result<GrpcResponse, String> {
    let (cancel, cancelled) = oneshot::channel();
    state.0.lock().unwrap().insert(id.clone(), cancel);
    let result = tokio::select! {
        r = call(Path::new(&root), &target, &body, metadata, timeout, connect_timeout) => r,
        _ = cancelled => Err("Cancelled".into()),
    };
    state.0.lock().unwrap().remove(&id);
    result
}

#[tauri::command]
pub fn grpc_cancel(state: State<'_, GrpcState>, id: String) {
    if let Some(cancel) = state.0.lock().unwrap().remove(&id) {
        let _ = cancel.send(());
    }
}

/// Every `package.Service/Method` at `address`, from reflection or else the project's .proto files.
#[tauri::command]
pub async fn grpc_methods(root: String, address: String) -> Result<Vec<String>, String> {
    let target = format!("{address}/");
    let (tls, address, _, _) = parse_target(&target)?;
    let mut methods = Vec::new();
    let listed = match connect(tls, address, 5.0).await {
        Ok(channel) => reflect(&channel, MessageRequest::ListServices(String::new())).await.ok().map(|r| (channel, r)),
        Err(_) => None,
    };
    if let Some((channel, MessageResponse::ListServicesResponse(list))) = listed {
        for s in list.service.iter().filter(|s| !s.name.starts_with("grpc.reflection.")) {
            if let Some(service) = reflected_pool(&channel, &s.name).await.ok().and_then(|pool| pool.get_service_by_name(&s.name)) {
                methods.extend(service.methods().map(|m| format!("{}/{}", s.name, m.name())));
            }
        }
    } else {
        let root = Path::new(&root);
        for s in proto_files(root).iter().filter_map(|f| compile(root, f).ok()).flat_map(|pool| pool.services().collect::<Vec<_>>()) {
            methods.extend(s.methods().map(|m| format!("{}/{}", s.full_name(), m.name())));
        }
    }
    methods.sort();
    methods.dedup();
    Ok(methods)
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost_reflect::Value;
    use std::convert::Infallible;
    use tonic::codegen::{http, BoxFuture, Context, Poll, Service};
    use tonic::server::{NamedService, StreamingService};
    use tonic::{Request, Response, Streaming};

    const PROTO: &str = r#"syntax = "proto3";
package test;
import "google/protobuf/timestamp.proto";
message Hello { string name = 1; int32 times = 2; google.protobuf.Timestamp at = 3; }
service Echo {
  rpc Say(Hello) returns (Hello);
  rpc Repeat(Hello) returns (stream Hello);
}
"#;

    /// Answers with "hi <name>", `times` times for Repeat, and NOT_FOUND for the name "fail".
    struct Handler(MethodDescriptor);

    impl StreamingService<DynamicMessage> for Handler {
        type Response = DynamicMessage;
        type ResponseStream = tokio_stream::Iter<std::vec::IntoIter<Result<DynamicMessage, Status>>>;
        type Future = BoxFuture<Response<Self::ResponseStream>, Status>;
        fn call(&mut self, request: Request<Streaming<DynamicMessage>>) -> Self::Future {
            let method = self.0.clone();
            let token = request.metadata().get("x-token").map(|v| v.to_str().unwrap().to_string());
            Box::pin(async move {
                let hello = request.into_inner().message().await?.unwrap();
                let name = hello.get_field_by_name("name").unwrap().as_str().unwrap().to_string();
                if name == "fail" {
                    return Err(Status::not_found("nobody"));
                }
                let mut reply = DynamicMessage::new(method.output());
                reply.set_field_by_name("name", Value::String(format!("hi {name}{}", token.map(|t| format!(" {t}")).unwrap_or_default())));
                let times = hello.get_field_by_name("times").unwrap().as_i32().unwrap().max(1) as usize;
                Ok(Response::new(tokio_stream::iter(vec![Ok(reply); times])))
            })
        }
    }

    #[derive(Clone)]
    struct Echo(DescriptorPool);

    impl NamedService for Echo {
        const NAME: &'static str = "test.Echo";
    }

    impl Service<http::Request<tonic::body::Body>> for Echo {
        type Response = http::Response<tonic::body::Body>;
        type Error = Infallible;
        type Future = BoxFuture<Self::Response, Infallible>;
        fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
            Poll::Ready(Ok(()))
        }
        fn call(&mut self, request: http::Request<tonic::body::Body>) -> Self::Future {
            let name = request.uri().path().rsplit('/').next().unwrap().to_string();
            let method = self.0.get_service_by_name("test.Echo").unwrap().methods().find(|m| m.name() == name).unwrap();
            Box::pin(async move { Ok(tonic::server::Grpc::new(DynamicCodec(method.input())).streaming(Handler(method), request).await) })
        }
    }

    /// A project folder with the proto in proto/test/, and an Echo server with or without reflection.
    async fn serve(reflection: bool) -> (String, PathBuf) {
        let root = std::env::temp_dir().join(format!("tusk-grpc-{}-{reflection}", std::process::id()));
        std::fs::create_dir_all(root.join("proto/test")).unwrap();
        std::fs::write(root.join("proto/test/echo.proto"), PROTO).unwrap();
        let mut compiler = protox::Compiler::new([root.join("proto")]).unwrap();
        compiler.include_imports(true).open_file("test/echo.proto").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let mut router = tonic::transport::Server::builder().add_service(Echo(compiler.descriptor_pool()));
        if reflection {
            router = router.add_service(tonic_reflection::server::Builder::configure().register_file_descriptor_set(compiler.file_descriptor_set()).build_v1alpha().unwrap());
        }
        tokio::spawn(router.serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener)));
        (address, root)
    }

    #[test]
    fn parses_targets() {
        assert_eq!(parse_target("localhost:50051/test.Echo/Say"), Ok((false, "localhost:50051", "test.Echo", "Say")));
        assert_eq!(parse_target("grpcs://api.example.com/a.b.C/D"), Ok((true, "api.example.com", "a.b.C", "D")));
        assert!(parse_target("ws://x/a.B/C").is_err());
        assert!(parse_target("localhost:50051").is_err());
    }

    #[tokio::test]
    async fn calls_with_reflection() {
        let (address, root) = serve(true).await;
        let target = format!("{address}/test.Echo/Say");
        let body = r#"{"name": "Ada", "at": "2026-09-26T00:00:00Z"}"#;
        let r = call(&root, &target, body, vec![("X-Token".into(), "t1".into())], 10.0, 5.0).await.unwrap();
        assert_eq!((r.status, r.status_text.as_str()), (200, "OK"));
        let json: serde_json::Value = serde_json::from_str(&r.body).unwrap();
        assert_eq!(json["name"], "hi Ada t1");
        assert_eq!(json["times"], 0, "default fields are shown");
        let r = call(&root, &format!("{address}/test.Echo/Repeat"), r#"{"name": "Bo", "times": 3}"#, vec![], 10.0, 5.0).await.unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&r.body).unwrap().as_array().unwrap().len(), 3);
        let r = call(&root, &target, r#"{"name": "fail"}"#, vec![], 10.0, 5.0).await.unwrap();
        assert_eq!((r.status, r.status_text.as_str()), (404, "NOT_FOUND"));
        assert!(r.headers.contains(&("grpc-message".into(), "nobody".into())));
        assert!(call(&root, &format!("{address}/test.Echo/Nope"), "", vec![], 10.0, 5.0).await.unwrap_err().contains("has no method Nope"));
        assert!(call(&root, &target, r#"{"nam": 1}"#, vec![], 10.0, 5.0).await.unwrap_err().contains("doesn't match test.Hello"));
        assert_eq!(grpc_methods(root.display().to_string(), address).await.unwrap(), ["test.Echo/Repeat", "test.Echo/Say"]);
    }

    #[tokio::test]
    async fn calls_with_project_protos() {
        let (address, root) = serve(false).await;
        let r = call(&root, &format!("{address}/test.Echo/Say"), r#"{"name": "Cy"}"#, vec![], 10.0, 5.0).await.unwrap();
        assert!(r.body.contains("hi Cy"), "{}", r.body);
        assert_eq!(grpc_methods(root.display().to_string(), address.clone()).await.unwrap(), ["test.Echo/Repeat", "test.Echo/Say"]);
        let empty = std::env::temp_dir().join(format!("tusk-grpc-{}-empty", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        assert!(call(&empty, &format!("{address}/test.Echo/Say"), "{}", vec![], 10.0, 5.0).await.unwrap_err().contains("No .proto file in the project declares test.Echo"));
    }
}
