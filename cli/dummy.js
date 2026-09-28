const express = require('express');
const app = express();

app.use(express.json());

app.post('/v1/messages', (req, res) => {
  console.log("Received Anthropic API request");
  res.json({
    id: "msg_dummy123",
    type: "message",
    role: "assistant",
    model: req.body.model || "claude-3",
    content: [
      {
        type: "text",
        text: "Działa! To jest odpowiedź z lokalnego Dummy API."
      }
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 20
    }
  });
});

app.listen(8080, () => {
  console.log('Dummy Anthropic API listening on port 8080');
});
