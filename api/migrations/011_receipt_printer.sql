-- Optional network receipt printer (Epson ESC/POS, raw TCP) per project, for printing cards as tickets.
alter table projects
  add column receipt_printer_host text,
  add column receipt_printer_port integer;
