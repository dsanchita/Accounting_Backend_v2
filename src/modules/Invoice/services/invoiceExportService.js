import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import AppError from "../../../utils/AppError.js";
import {
  generateWordDocument,
  generatePdfFromWord,
  formatDate,
} from "../../../utils/documentGenerator.js";

const INVOICE_TEMPLATE_WITH_SIGNATURE = "Invoice-Template With Signeture.docx";
const INVOICE_TEMPLATE_WITHOUT_SIGNATURE = "Invoice-Template without signeture.docx";

const formatMoney = (value) => {
  const numberValue = Number(value || 0);
  return Number.isNaN(numberValue) ? "0.00" : numberValue.toFixed(2);
};

const normalizeInvoiceItems = (items = []) => {
  return items.map((item, idx) => ({
    index: idx + 1,
    description: item.description || "",
    hsnSac: item.hsnSac || "",
    quantity: item.quantity ?? 0,
    rate: formatMoney(item.rate ?? item.unitPrice ?? 0),
    taxableValue: formatMoney(item.taxableValue || item.taxAmount || 0),
    gstRate: item.gstRate ?? item.taxRate ?? 0,
    gstAmount: formatMoney(item.gstAmount ?? item.taxAmount ?? 0),
    total: formatMoney(item.totalAmount ?? item.total ?? 0),
  }));
};

export const prepareInvoiceData = (invoice) => {
  const billTo = invoice.billTo || {};
  const shipTo = invoice.shipTo || {};

  const poReference =
    invoice.poreferencevalue ||
    (invoice.linkedPO && typeof invoice.linkedPO === "object" ? invoice.linkedPO.poreferencevalue : "") ||
    "";

  return {
    InvoiceNo: invoice.invoiceNo || "",
    InvoiceDate: formatDate(invoice.invoiceDate),
    DueDate: formatDate(invoice.dueDate),
    referenceDate: formatDate(invoice.referenceDate),
    purchaseorderreference: poReference,
    Currency: invoice.currency || "INR",
    AmountDue: formatMoney(invoice.amountDue ?? invoice.invoiceAmount ?? 0),
    TotalTaxableValue: formatMoney(invoice.totalTaxableValue || 0),
    CGST: formatMoney(invoice.totalCGSTAmount || 0),
    SGST: formatMoney(invoice.totalSGSTAmount || 0),
    IGST: formatMoney(invoice.totalIGSTAmount || 0),
    ValueInFigure: invoice.valueInWords || "",
    PaymentMode: invoice.paymentMode || invoice.paymentMode || "",
    BillToAddress: billTo.address || "",
    BillToClientName: billTo.name || "",
    BillToGSTIN: billTo.GSTIN || billTo.gstin || "",
    BillToStateCode: billTo.stateCode || "",
    ShipToAddress: shipTo.address || "",
    ShipToClientName: shipTo.name || "",
    ShipToGSTIN: shipTo.GSTIN || shipTo.gstin || "",
    ShipToStateCode: shipTo.stateCode || "",
    items: normalizeInvoiceItems(invoice.items),
  };
};

export const exportInvoice = async (invoice, format = "pdf", outputDir = "./uploads/exports") => {
  try {
    mkdirSync(outputDir, { recursive: true });

    if (!invoice.poreferencevalue && invoice.linkedPO) {
      if (typeof invoice.linkedPO === "object" && invoice.linkedPO.poreferencevalue) {
        invoice.poreferencevalue = invoice.linkedPO.poreferencevalue;
      } else if (typeof invoice.linkedPO === "string" || invoice.linkedPO._id) {
        try {
          const { getPurchaseOrderModel } = await import("../repos/purchaseOrderRepo.js");
          const PurchaseOrder = await getPurchaseOrderModel();
          const poId = invoice.linkedPO._id || invoice.linkedPO;
          const po = await PurchaseOrder.findById(poId).select("poreferencevalue").lean();
          if (po?.poreferencevalue) {
            invoice.poreferencevalue = po.poreferencevalue;
          }
        } catch (_) {}
      }
    }

    const templateName = invoice.withSignature
      ? INVOICE_TEMPLATE_WITH_SIGNATURE
      : INVOICE_TEMPLATE_WITHOUT_SIGNATURE;

    const data = prepareInvoiceData(invoice);
    const wordBuffer = await generateWordDocument(templateName, data);
    const baseFileName = `INV-${invoice.invoiceNo}-${Date.now()}`;
    const results = {};

    if (format === "word" || format === "both") {
      const wordPath = join(outputDir, `${baseFileName}.docx`);
      writeFileSync(wordPath, wordBuffer);
      results.wordPath = wordPath;
      results.wordFileName = `${baseFileName}.docx`;
    }

    if (format === "pdf" || format === "both") {
      const pdfBuffer = await generatePdfFromWord(wordBuffer);
      const pdfPath = join(outputDir, `${baseFileName}.pdf`);
      writeFileSync(pdfPath, pdfBuffer);
      results.pdfPath = pdfPath;
      results.pdfFileName = `${baseFileName}.pdf`;
    }

    return {
      success: true,
      message: `Invoice exported as ${format}`,
      files: results,
    };
  } catch (error) {
    if (error.statusCode) throw error;
    throw new AppError(error.message, 500, "exportInvoice");
  }
};

export const exportInvoiceList = async (invoices, format = "csv", outputDir = "./uploads/exports") => {
  try {
    mkdirSync(outputDir, { recursive: true });

    if (format === "csv") {
      const headers = [
        "Invoice No",
        "Invoice Date",
        "Bill To",
        "Amount",
        "Status",
        "Amount Due",
      ];
      const rows = invoices.map((inv) => [
        inv.invoiceNo,
        new Date(inv.invoiceDate).toLocaleDateString(),
        inv.billTo?.name || "",
        inv.invoiceAmount,
        inv.status,
        inv.amountDue,
      ]);

      const csvContent = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
      const fileName = `Invoice-List-${Date.now()}.csv`;
      const filePath = join(outputDir, fileName);

      writeFileSync(filePath, csvContent, "utf-8");

      return {
        success: true,
        message: "Invoice list exported as CSV",
        filePath,
        fileName,
      };
    }

    throw new AppError("Format not supported", 400, "exportInvoiceList");
  } catch (error) {
    if (error.statusCode) throw error;
    throw new AppError(error.message, 500, "exportInvoiceList");
  }
};
