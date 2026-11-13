#[path = "../../../rust/protocol.rs"]
mod protocol;

use protocol::Json;

const NAME: &str = "payment";
const VERSION: &str = "0.1.0";
const CAPABILITIES: &[&str] = &["payment.request"];

fn main() {
    protocol::run(NAME, VERSION, CAPABILITIES, invoke);
}

fn invoke(capability: &str, params: &Json) -> Result<Json, String> {
    match capability {
        "payment.request" => {
            let amount = params
                .get("amount")
                .cloned()
                .unwrap_or_else(|| Json::number("100"));
            let currency = params
                .get("currency")
                .and_then(Json::as_str)
                .unwrap_or("USD");
            Ok(Json::object(vec![
                ("approved", Json::Bool(true)),
                ("transaction", Json::string("mock-payment-1")),
                ("amount", amount),
                ("currency", Json::string(currency)),
                ("mock", Json::Bool(true)),
            ]))
        }
        other => Err(format!("unknown capability: {other}")),
    }
}
